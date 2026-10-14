import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../security/current-user.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { JwtPayload } from '../security/jwt-payload';
import { PayDto } from './dto/pay.dto';
import { PaymentDto } from './dto/payment.dto';
import { IdempotencyKeyHeader } from './idempotency-key.decorator';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiUnauthorizedResponse({ description: 'Token faltante, inválido o expirado' })
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('by-reservation/:reservationId')
  @ApiOperation({ summary: 'Pago de una reserva', description: 'El pago se crea solo al reservar con seña. Solo lo ve quien reservó.' })
  @ApiOkResponse({ type: PaymentDto })
  @ApiNotFoundResponse({ description: 'No hay pago para esa reserva (o no es tuya)' })
  byReservation(@CurrentUser() user: JwtPayload, @Param('reservationId', ParseUUIDPipe) reservationId: string) {
    return this.payments.findByReservation(reservationId, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un pago' })
  @ApiOkResponse({ type: PaymentDto })
  @ApiNotFoundResponse({ description: 'El pago no existe (o no es tuyo)' })
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.findOne(id, user);
  }

  @Post(':id/pay')
  @ApiOperation({
    summary: 'Pagar la seña',
    description:
      'Cobra el pago con el token indicado. **Idempotency-Key obligatorio**: repetir el pedido con la misma clave devuelve ' +
      'la misma respuesta sin cobrar de nuevo (doble clic, reintento por timeout). Usá una clave nueva para cada intento distinto. ' +
      'Si la pasarela responde en el momento, devuelve 200 con el estado final (SUCCEEDED o FAILED). Si queda pendiente, ' +
      'devuelve 202 (PROCESSING) y el resultado se conoce consultando el pago.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Entre 8 y 100 caracteres. Ej: un UUID', example: 'b1f6d3a0-5c1e-4f6e-9a55-2f1d7c1e8a10' })
  @ApiOkResponse({ type: PaymentDto, description: 'Cobro resuelto: SUCCEEDED o FAILED' })
  @ApiAcceptedResponse({ type: PaymentDto, description: 'La pasarela todavía no resolvió (PROCESSING)' })
  @ApiBadRequestResponse({ description: 'Falta o es inválido el Idempotency-Key, o el token' })
  @ApiNotFoundResponse({ description: 'El pago no existe (o no es tuyo)' })
  @ApiConflictResponse({ description: 'El pago ya no está pendiente (ya se pagó, venció o se canceló la reserva)' })
  @ApiUnprocessableEntityResponse({ description: 'Ese Idempotency-Key ya se usó con otro pedido' })
  @ApiBadGatewayResponse({ description: 'La pasarela no respondió. No se cobró nada; se puede reintentar con la misma clave' })
  async pay(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayDto,
    @IdempotencyKeyHeader() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const result = await this.payments.pay(user, id, dto.token, idempotencyKey);
    res.status(result.status === 202 ? HttpStatus.ACCEPTED : HttpStatus.OK);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
