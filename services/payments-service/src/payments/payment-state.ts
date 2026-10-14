import { ConflictException } from '@nestjs/common';
import { PaymentStatus } from './entities/payment-status.enum';

const { PENDING, PROCESSING, SUCCEEDED, FAILED, EXPIRED, CANCELLED, REFUNDED } = PaymentStatus;

/**
 * Máquina de estados del pago: de qué estado se puede pasar a cuál.
 *
 * EXPIRED y CANCELLED solo se alcanzan desde PENDING (todavía no se cobró nada). Si la reserva vence o se
 * cancela mientras la pasarela está cobrando (PROCESSING), el pago NO se toca: cuando llegue el resultado se
 * registra tal cual y reservations-service pide la devolución si ya no hay reserva (ver ReservationEventsConsumer).
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PENDING]: [PROCESSING, SUCCEEDED, FAILED, EXPIRED, CANCELLED],
  [PROCESSING]: [SUCCEEDED, FAILED],
  [SUCCEEDED]: [REFUNDED],
  [FAILED]: [],
  [EXPIRED]: [],
  [CANCELLED]: [],
  [REFUNDED]: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`No se puede pasar un pago de ${from} a ${to}`);
  }
}
