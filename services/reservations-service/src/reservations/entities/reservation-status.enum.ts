/**
 * Estados de una reserva. Por ahora no hay cobro de seña, así que toda reserva nace CONFIRMED.
 * Cuando exista payments-service se suman PENDING_PAYMENT (esperando la seña) y EXPIRED (no pagó a tiempo).
 */
export enum ReservationStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED', // el cliente fue
  NO_SHOW = 'NO_SHOW', // el cliente no se presentó
}
