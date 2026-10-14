/**
 * Contrato de eventos con reservations-service (se duplica a propósito: cada servicio es independiente;
 * ver reservation-events.ts del otro lado). El `type` es la routing key en RabbitMQ.
 */
export const ReservationEvents = {
  CREATED: 'reservation.created',
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
  /** 0 = la reserva no tenía seña, así que no hay nada que anular ni devolver. */
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
