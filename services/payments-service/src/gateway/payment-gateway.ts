/**
 * Contrato con la pasarela de pagos. El resto del servicio solo conoce esta interfaz, así que cambiar de
 * pasarela (simulada → Mercado Pago, Stripe...) es escribir un adaptador nuevo y elegirlo con PAYMENT_PROVIDER.
 *
 * Qué tiene que cumplir un adaptador real:
 *  - createCharge: cobrar. Puede resolver al instante (succeeded/failed) o quedar 'pending' y avisar después por webhook.
 *    Tiene que ser idempotente con `idempotencyKey` (reintentar no cobra dos veces).
 *  - parseWebhook: validar la firma del webhook con el secreto del proveedor y traducirlo a GatewayWebhookEvent.
 *  - refund: devolver el dinero de un cobro; idempotente con `idempotencyKey`.
 */
export interface ChargeInput {
  paymentId: string;
  amountCents: number;
  currency: string;
  /** Medio de pago tokenizado en el navegador (nunca llegan los datos de la tarjeta a nuestro servidor). */
  token: string;
  /** Clave estable por pago: reintentar el mismo cobro no genera un segundo cargo. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { status: 'succeeded'; chargeId: string }
  | { status: 'failed'; chargeId: string; reason: string }
  | { status: 'pending'; chargeId: string };

export interface RefundInput {
  chargeId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface RefundResult {
  refundId: string;
}

export interface GatewayWebhookEvent {
  /** Id único del evento en la pasarela (para descartar repetidos). */
  eventId: string;
  type: 'charge.succeeded' | 'charge.failed';
  chargeId: string;
  failureReason?: string;
}

export interface PaymentGateway {
  readonly name: string;
  createCharge(input: ChargeInput): Promise<ChargeResult>;
  /** Verifica la firma sobre el cuerpo CRUDO y devuelve el evento. Lanza InvalidWebhookError si no es auténtico. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayWebhookEvent;
  refund(input: RefundInput): Promise<RefundResult>;
}

/** Token de inyección de Nest para pedir "la pasarela configurada". */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** La pasarela no respondió o falló por un problema transitorio: el cobro NO se hizo y se puede reintentar. */
export class GatewayUnavailableError extends Error {}

/** El webhook no es auténtico (firma ausente, inválida o vencida). */
export class InvalidWebhookError extends Error {}
