import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { ListRestaurantReservationsQueryDto, RestaurantSummaryQueryDto, UpdateReservationStatusDto } from './dto/owner.dto';
import { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant-input.dto';

/**
 * Panel del dueño. El BFF solo reenvía: quién es dueño de qué lo decide cada servicio
 * (restaurants-service para "mis restaurantes", reservations-service para ver y modificar las reservas
 * de un local), así que un cliente o un dueño ajeno recibe el 403 del servicio y no hay reglas duplicadas.
 * Para cancelar se reutiliza POST /reservations/:id/cancel, que ya acepta al dueño.
 */
@ApiTags('owner')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@ApiForbiddenResponse({ description: 'No sos dueño (o no de este restaurante)' })
@Controller('owner')
export class OwnerController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get('restaurants')
  @ApiOperation({ summary: 'Mis restaurantes (solo RESTAURANT_OWNER)' })
  restaurants(@Ctx() ctx: CallContext) {
    return this.upstream.call('restaurants', { path: '/restaurants/mine' }, ctx);
  }

  @Post('restaurants')
  @ApiOperation({ summary: 'Crear un restaurante (el dueño es el usuario del token)' })
  createRestaurant(@Body() dto: CreateRestaurantDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('restaurants', { method: 'POST', path: '/restaurants', body: dto }, ctx);
  }

  @Patch('restaurants/:id')
  @ApiOperation({ summary: 'Modificar un restaurante mío (datos, mesas u horarios). Las reservas ya hechas no se revalidan.' })
  updateRestaurant(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateRestaurantDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('restaurants', { method: 'PATCH', path: `/restaurants/${id}`, body: dto }, ctx);
  }

  @Delete('restaurants/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un restaurante mío y su carta. Las reservas existentes no se tocan.' })
  async removeRestaurant(@Param('id', ParseObjectIdPipe) id: string, @Ctx() ctx: CallContext) {
    await this.upstream.call('restaurants', { method: 'DELETE', path: `/restaurants/${id}` }, ctx);
  }

  @Get('restaurants/:id/reservations')
  @ApiOperation({ summary: 'Reservas de un restaurante mío. Filtros: date (YYYY-MM-DD), status, page, limit' })
  reservations(@Param('id', ParseObjectIdPipe) id: string, @Query() query: ListRestaurantReservationsQueryDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('reservations', { path: `/reservations/restaurant/${id}`, query: { ...query } }, ctx);
  }

  @Get('restaurants/:id/summary')
  @ApiOperation({ summary: 'Resumen de un día de un restaurante mío: cuántas reservas hay por estado' })
  summary(@Param('id', ParseObjectIdPipe) id: string, @Query() query: RestaurantSummaryQueryDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('reservations', { path: `/reservations/restaurant/${id}/summary`, query: { date: query.date } }, ctx);
  }

  @Patch('reservations/:id/status')
  @ApiOperation({ summary: 'Marcar una reserva como COMPLETED (asistió) o NO_SHOW (no vino)' })
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReservationStatusDto, @Ctx() ctx: CallContext) {
    return this.upstream.call('reservations', { method: 'PATCH', path: `/reservations/${id}/status`, body: dto }, ctx);
  }
}
