import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { CreateOwnerRequestDto, ListOwnerRequestsQueryDto, RejectOwnerRequestDto } from './dto/owner-requests.dto';

/**
 * Solicitudes para ser dueño. El BFF solo reenvía: quién puede enviar, ver o revisar lo decide auth-service
 * (un cliente que intenta aprobar recibe su 403), así que las reglas no se duplican.
 */
@ApiTags('owner-requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@Controller('owner-requests')
export class OwnerRequestsController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Post()
  @ApiOperation({ summary: 'Pedir ser dueño de restaurante (solo clientes)' })
  @ApiConflictResponse({ description: 'Ya tiene una solicitud pendiente' })
  @ApiForbiddenResponse({ description: 'La cuenta no es de cliente' })
  create(@Body() dto: CreateOwnerRequestDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { method: 'POST', path: '/owner-requests', body: dto }, ctx);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Mi última solicitud, con su estado' })
  @ApiNotFoundResponse({ description: 'Todavía no envió ninguna' })
  mine(@Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { path: '/owner-requests/mine' }, ctx);
  }

  @Get()
  @ApiOperation({ summary: 'Solicitudes por estado (solo ADMIN). Filtros: status, page, limit' })
  @ApiForbiddenResponse({ description: 'No es admin' })
  list(@Query() query: ListOwnerRequestsQueryDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { path: '/owner-requests', query: { ...query } }, ctx);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprobar: el usuario pasa a ser dueño (solo ADMIN)' })
  @ApiConflictResponse({ description: 'Ya fue revisada' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { method: 'POST', path: `/owner-requests/${id}/approve` }, ctx);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechazar con un motivo, que ve el usuario (solo ADMIN)' })
  @ApiConflictResponse({ description: 'Ya fue revisada' })
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectOwnerRequestDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('auth', { method: 'POST', path: `/owner-requests/${id}/reject`, body: dto }, ctx);
  }
}
