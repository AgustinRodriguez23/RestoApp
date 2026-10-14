/**
 * Estados de un pago.
 *
 *   PENDING ──pay──▶ SUCCEEDED ──refund──▶ REFUNDED
 *      │    └──────▶ FAILED
 *      │    └──────▶ PROCESSING ──webhook──▶ SUCCEEDED | FAILED     (pasarela asíncrona)
 *      ├──reserva vencida──▶ EXPIRED
 *      └──reserva cancelada──▶ CANCELLED
 */
export enum PaymentStatus {
  PENDING = 'PENDING', // creado al reservar; esperando que el cliente pague
  PROCESSING = 'PROCESSING', // la pasarela lo recibió pero todavía no resolvió (llega por webhook)
  SUCCEEDED = 'SUCCEEDED', // cobrado
  FAILED = 'FAILED', // la pasarela lo rechazó
  EXPIRED = 'EXPIRED', // la reserva venció antes de pagar
  CANCELLED = 'CANCELLED', // la reserva se canceló antes de pagar
  REFUNDED = 'REFUNDED', // devuelto
}
