import { Body, Controller, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Ctx } from '../security/call-context.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { IdempotencyKeyHeader } from './idempotency-key.decorator';
import { PayReservationDto } from './dto/reservations.dto';
import { PaymentSummary } from './reservations-enricher.service';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * El frontend solo conoce el id de la RESERVA. Estas rutas le esconden el id del pago y el hecho de que
 * el pago lo crea payments-service de forma asíncrona (reacciona a un evento al reservar).
 */
@ApiTags('reservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@Controller('reservations')
export class ReservationPaymentsController {
  private readonly lookupAttempts: number;
  private readonly lookupDelayMs: number;

  constructor(
    private readonly upstream: UpstreamClient,
    config: ConfigService,
  ) {
    this.lookupAttempts = Number(config.get('PAYMENT_LOOKUP_ATTEMPTS') ?? 6);
    this.lookupDelayMs = Number(config.get('PAYMENT_LOOKUP_DELAY_MS') ?? 300);
  }

  @Get(':id/payment')
  @ApiOperation({ summary: 'Estado del pago de la seña de una reserva' })
  @ApiOkResponse({ description: 'El pago (PENDING, PROCESSING, SUCCEEDED, FAILED, EXPIRED, CANCELLED o REFUNDED)' })
  payment(@Param('id', ParseUUIDPipe) id: string, @Ctx() ctx: CallContext) {
    return this.upstream.call<PaymentSummary>('payments', { path: `/payments/by-reservation/${id}` }, ctx);
  }

  @Post(':id/pay')
  @ApiOperation({
    summary: 'Pagar la seña de una reserva',
    description:
      'Header **Idempotency-Key** obligatorio: reintentar con la misma clave no cobra dos veces. Respuesta 200 con el pago ya resuelto ' +
      '(SUCCEEDED/FAILED) o 202 si la pasarela todavía está procesando (consultá `GET /reservations/:id/payment`). ' +
      'Si el pago recién se está preparando (se crea al reservar, de forma asíncrona), espera unos segundos antes de rendirse.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, example: 'b1f6d3a0-5c1e-4f6e-9a55-2f1d7c1e8a10' })
  @ApiOkResponse({ description: 'Pago resuelto' })
  @ApiAcceptedResponse({ description: 'La pasarela todavía está procesando el pago' })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayReservationDto,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Ctx() ctx: CallContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const payment = await this.findPaymentWhenReady(id, ctx);
    // El POST nunca se reintenta solo (UpstreamClient lo garantiza): la protección contra el doble cobro es la Idempotency-Key
    const result = await this.upstream.callWithStatus<PaymentSummary>(
      'payments',
      { method: 'POST', path: `/payments/${payment.id}/pay`, body: dto, headers: { 'Idempotency-Key': idempotencyKey } },
      ctx,
    );
    res.status(result.status === 202 ? HttpStatus.ACCEPTED : HttpStatus.OK);
    // Si payments-service contestó con la respuesta guardada de una Idempotency-Key repetida, el cliente también se entera
    if (result.headers.get('idempotent-replayed') === 'true') res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  /**
   * Al reservar, el pago aparece unos milisegundos después (lo crea un evento). Si el usuario aprieta "Pagar"
   * justo en ese instante, se espera un poco en vez de contestar un 404 confuso.
   */
  private async findPaymentWhenReady(reservationId: string, ctx: CallContext): Promise<PaymentSummary> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.upstream.call<PaymentSummary>('payments', { path: `/payments/by-reservation/${reservationId}` }, ctx);
      } catch (error) {
        const notYet = error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND;
        if (!notYet) throw error;
        if (attempt >= this.lookupAttempts) {
          throw new HttpException(
            { statusCode: 404, error: 'Not Found', message: 'Esta reserva no tiene un pago pendiente (o todavía se está preparando; probá de nuevo en unos segundos).' },
            HttpStatus.NOT_FOUND,
          );
        }
        await sleep(this.lookupDelayMs);
      }
    }
  }
}
