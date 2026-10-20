import { Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { JwtPayload } from '../security/jwt-payload';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { NotificationsService } from './notifications.service';

/**
 * La bandeja del usuario autenticado. No hay roles ni "ver las de otro": todo se filtra por el `sub` del JWT,
 * así que nadie puede leer ni tocar las notificaciones de otra persona.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Mis notificaciones (la más nueva primero) y cuántas tengo sin leer' })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListNotificationsQueryDto) {
    return this.notifications.list(user.sub, query);
  }

  // Las rutas fijas van ANTES de las que llevan :id, para que "unread-count" no se interprete como un id
  @Get('unread-count')
  @ApiOperation({ summary: 'Cantidad de notificaciones sin leer (para el contador de la campanita)' })
  async unreadCount(@CurrentUser() user: JwtPayload) {
    return { count: await this.notifications.unreadCount(user.sub) };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marca todas mis notificaciones como leídas' })
  readAll(@CurrentUser() user: JwtPayload) {
    return this.notifications.markAllRead(user.sub);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marca una notificación como leída' })
  markRead(@CurrentUser() user: JwtPayload, @Param('id', ParseObjectIdPipe) id: string) {
    return this.notifications.markRead(user.sub, id);
  }
}
