/**
 * Estados de una reserva.
 *
 * Con seña (DEPOSIT_PER_PERSON_CENTS > 0) el camino es:
 *   PENDING_PAYMENT ──pago aprobado──▶ CONFIRMED ──▶ COMPLETED | NO_SHOW | CANCELLED
 *        │
 *        ├──pago rechazado / cancelada por el cliente──▶ CANCELLED
 *        └──no pagó a tiempo──▶ EXPIRED
 * Sin seña, la reserva nace CONFIRMED directamente.
 *
 * PENDING_PAYMENT y CONFIRMED bloquean la mesa; los demás estados la liberan.
 */
export enum ReservationStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT', // esperando la seña; la mesa está retenida hasta expiresAt
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED', // no pagó a tiempo
  COMPLETED = 'COMPLETED', // el cliente fue
  NO_SHOW = 'NO_SHOW', // el cliente no se presentó
}

/** Estados en los que la reserva ocupa la mesa. */
export const BLOCKING_STATUSES = [ReservationStatus.CONFIRMED, ReservationStatus.PENDING_PAYMENT] as const;
