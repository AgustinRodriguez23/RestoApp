import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Payment } from '../entities/payment.entity';
import { PaymentStatus } from '../entities/payment-status.enum';

/** Forma de un pago en las respuestas. No expone datos internos de la pasarela. */
export class PaymentDto {
  @ApiProperty({ example: '9b2c3d4e-1111-4c0e-9d3a-7a1f2b6c9d10' })
  id: string;

  @ApiProperty({ example: '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10' })
  reservationId: string;

  @ApiProperty({ example: 600000, description: 'Importe en centavos' })
  amountCents: number;

  @ApiProperty({ example: 'ARS' })
  currency: string;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ description: 'Hasta cuándo se puede pagar' })
  expiresAt: string;

  @ApiPropertyOptional({ nullable: true, example: 'simulated' })
  provider: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'card_declined' })
  failureReason: string | null;

  @ApiPropertyOptional({ nullable: true })
  paidAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  refundedAt: string | null;

  @ApiProperty()
  createdAt: string;
}

export function toPaymentDto(payment: Payment): PaymentDto {
  return {
    id: payment.id,
    reservationId: payment.reservationId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    expiresAt: payment.expiresAt.toISOString(),
    provider: payment.provider,
    failureReason: payment.failureReason,
    paidAt: payment.paidAt?.toISOString() ?? null,
    refundedAt: payment.refundedAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
  };
}
