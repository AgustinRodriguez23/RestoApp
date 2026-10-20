import { Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { ListNotificationsQueryDto } from './dto/notifications.dto';

/**
 * La bandeja del usuario. El BFF solo valida la forma del pedido y reenvía con el token: quién es el dueño de cada
 * notificación lo decide notifications-service (todo se filtra por el `sub` del JWT), no se repite acá.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get()
  @ApiOperation({ summary: 'Mis notificaciones (la más nueva primero) y cuántas tengo sin leer' })
  list(@Query() query: ListNotificationsQueryDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('notifications', { path: '/notifications', query: { ...query } }, ctx);
  }

  // Las rutas fijas van antes que ":id/read" para que no se confundan con un id
  @Get('unread-count')
  @ApiOperation({ summary: 'Cantidad de notificaciones sin leer (el contador de la campanita)' })
  unreadCount(@Ctx() ctx: CallContext) {
    return this.upstream.call('notifications', { path: '/notifications/unread-count' }, ctx);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar todas como leídas' })
  readAll(@Ctx() ctx: CallContext) {
    return this.upstream.call('notifications', { method: 'POST', path: '/notifications/read-all' }, ctx);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marcar una como leída' })
  markRead(@Param('id', ParseObjectIdPipe) id: string, @Ctx() ctx: CallContext) {
    return this.upstream.call('notifications', { method: 'PATCH', path: `/notifications/${id}/read` }, ctx);
  }
}
