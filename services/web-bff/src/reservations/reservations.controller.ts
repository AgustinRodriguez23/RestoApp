import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { CreateReservationDto, ListMyReservationsQueryDto } from './dto/reservations.dto';
import { PaymentsEnricher, ReservationsEnricher } from './reservations-enricher.service';

interface Reservation {
  id: string;
  restaurantId: string;
  depositCents?: number;
}
interface Page<T> {
  data: T[];
  [key: string]: unknown;
}

@ApiTags('reservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly enricher: ReservationsEnricher,
    private readonly payments: PaymentsEnricher,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Crear una reserva (la mesa se asigna sola). 409 si ya no hay lugar.' })
  async create(@Body() dto: CreateReservationDto, @Ctx() ctx: CallContext) {
    const created = await this.upstream.call<Reservation>('reservations', { method: 'POST', path: '/reservations', body: dto }, ctx);
    return this.enrichOne(created, ctx);
  }

  // "mine" va antes que ":id" para que no se tome como un id
  @Get('mine')
  @ApiOperation({ summary: 'Mis reservas, con el nombre del restaurante y el estado del pago de la seña' })
  async mine(@Query() query: ListMyReservationsQueryDto, @Ctx() ctx: CallContext) {
    const page = await this.upstream.call<Page<Reservation>>('reservations', { path: '/reservations/mine', query: { ...query } }, ctx);
    return { ...page, data: await this.enrichMany(page.data, ctx) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver una reserva' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Ctx() ctx: CallContext) {
    return this.enrichOne(await this.upstream.call<Reservation>('reservations', { path: `/reservations/${id}` }, ctx), ctx);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar una reserva' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Ctx() ctx: CallContext) {
    const cancelled = await this.upstream.call<Reservation>('reservations', { method: 'POST', path: `/reservations/${id}/cancel` }, ctx);
    return this.enrichOne(cancelled, ctx);
  }

  private async enrichOne(reservation: Reservation, ctx: CallContext) {
    const [enriched] = await this.enrichMany([reservation], ctx);
    return enriched;
  }

  /** Nombre del restaurante + estado del pago, pedidos en paralelo (los dos son opcionales). */
  private async enrichMany(reservations: Reservation[], ctx: CallContext) {
    const [withRestaurant, withPayment] = await Promise.all([
      this.enricher.attachRestaurants(reservations, ctx),
      this.payments.attachPayments(reservations, ctx),
    ]);
    return withRestaurant.map((r, i) => ({ ...r, payment: withPayment[i].payment }));
  }
}
