/**
 * Tipos de eventos de la saga de la seña. Es el contrato entre reservations-service y payments-service:
 * el `type` es la routing key en RabbitMQ.
 *
 *  reservations ──reservation.created──────────▶ payments   (crea el cobro pendiente)
 *  payments     ──payment.succeeded────────────▶ reservations (PENDING_PAYMENT → CONFIRMED)
 *  payments     ──payment.failed───────────────▶ reservations (PENDING_PAYMENT → CANCELLED, libera la mesa)
 *  reservations ──reservation.expired──────────▶ payments   (anula el cobro pendiente)
 *  reservations ──reservation.cancelled────────▶ payments   (anula el cobro o devuelve la seña si refundable)
 *  reservations ──reservation.refund_requested─▶ payments   (pagó tarde: la reserva ya no existe, se devuelve)
 *  payments     ──payment.refunded─────────────▶ (informativo)
 */
export const ReservationEvents = {
  CREATED: 'reservation.created',
  CONFIRMED: 'reservation.confirmed',
  CANCELLED: 'reservation.cancelled',
  EXPIRED: 'reservation.expired',
  REFUND_REQUESTED: 'reservation.refund_requested',
} as const;

export const PaymentEvents = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
  REFUNDED: 'payment.refunded',
} as const;

export interface ReservationCreatedData {
  reservationId: string;
  customerId: string;
  restaurantId: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
}

export interface ReservationCancelledData {
  reservationId: string;
  customerId: string;
  restaurantId: string;
  reason: 'CANCELLED_BY_CUSTOMER' | 'CANCELLED_BY_OWNER' | 'PAYMENT_FAILED';
  refundable: boolean;
  /** 0 = la reserva no tenía seña: payments-service no tiene nada que anular ni devolver. */
  depositCents: number;
}

export interface ReservationExpiredData {
  reservationId: string;
  customerId: string;
  restaurantId: string;
}

export interface RefundRequestedData {
  reservationId: string;
  paymentId: string;
  reason: string;
}

export interface PaymentSucceededData {
  paymentId: string;
  reservationId: string;
  amountCents: number;
}

export interface PaymentFailedData {
  paymentId: string;
  reservationId: string;
  reason: string;
}
