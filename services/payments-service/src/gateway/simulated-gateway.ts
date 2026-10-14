import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ChargeInput,
  ChargeResult,
  GatewayUnavailableError,
  GatewayWebhookEvent,
  PaymentGateway,
  RefundInput,
  RefundResult,
} from './payment-gateway';
import { SIGNATURE_HEADER, signWebhook, verifyWebhookSignature } from './webhook-signature';

/**
 * Tokens de prueba (como los de las pasarelas reales en modo sandbox). El comportamiento depende del token:
 *
 *   tok_approved            → cobro aprobado al instante
 *   tok_declined            → rechazado (tarjeta rechazada)
 *   tok_insufficient_funds  → rechazado (fondos insuficientes)
 *   tok_error               → la pasarela "se cae" (GatewayUnavailableError): no se cobró, se puede reintentar
 *   tok_slow                → queda pendiente y el resultado (aprobado) llega por webhook unos segundos después
 *   tok_slow_declined       → ídem, pero el webhook dice rechazado
 *   tok_slow_duplicate      → ídem tok_slow, pero el webhook llega DOS veces (para ver la deduplicación)
 *
 * Cualquier otro token se rechaza como inválido.
 */
export const SIMULATED_TOKENS = [
  'tok_approved',
  'tok_declined',
  'tok_insufficient_funds',
  'tok_error',
  'tok_slow',
  'tok_slow_declined',
  'tok_slow_duplicate',
] as const;

export interface SimulatedGatewayOptions {
  webhookSecret: string;
  /** A dónde "llama" la pasarela con los webhooks (en el mundo real lo configura el comercio en el panel del proveedor). */
  webhookUrl: string;
  webhookDelayMs: number;
  /** Para tests: reemplaza a fetch. */
  fetchFn?: typeof fetch;
}

export class SimulatedGateway implements PaymentGateway {
  readonly name = 'simulated';
  private readonly logger = new Logger(SimulatedGateway.name);
  private readonly charges = new Map<string, ChargeResult>(); // idempotencia: clave → resultado
  private readonly refunds = new Map<string, RefundResult>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: SimulatedGatewayOptions) {}

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    const previous = this.charges.get(input.idempotencyKey);
    if (previous) return previous; // mismo pedido de cobro: misma respuesta, sin cobrar de nuevo

    const chargeId = `ch_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    let result: ChargeResult;

    switch (input.token) {
      case 'tok_approved':
        result = { status: 'succeeded', chargeId };
        break;
      case 'tok_declined':
        result = { status: 'failed', chargeId, reason: 'card_declined' };
        break;
      case 'tok_insufficient_funds':
        result = { status: 'failed', chargeId, reason: 'insufficient_funds' };
        break;
      case 'tok_error':
        // No se guarda: el cobro no ocurrió, el reintento tiene que volver a intentarlo
        throw new GatewayUnavailableError('la pasarela simulada no responde (tok_error)');
      case 'tok_slow':
      case 'tok_slow_duplicate':
        result = { status: 'pending', chargeId };
        this.scheduleWebhook({ type: 'charge.succeeded', chargeId }, input.token === 'tok_slow_duplicate' ? 2 : 1);
        break;
      case 'tok_slow_declined':
        result = { status: 'pending', chargeId };
        this.scheduleWebhook({ type: 'charge.failed', chargeId, failureReason: 'card_declined' }, 1);
        break;
      default:
        result = { status: 'failed', chargeId, reason: 'invalid_token' };
    }

    this.charges.set(input.idempotencyKey, result);
    return result;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayWebhookEvent {
    verifyWebhookSignature(this.options.webhookSecret, rawBody, headers[SIGNATURE_HEADER]);
    return JSON.parse(rawBody.toString('utf8')) as GatewayWebhookEvent;
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const previous = this.refunds.get(input.idempotencyKey);
    if (previous) return previous;
    const result = { refundId: `re_${randomUUID().replace(/-/g, '').slice(0, 20)}` };
    this.refunds.set(input.idempotencyKey, result);
    return result;
  }

  /** Nest lo llama al apagar el servicio: cancela los webhooks que todavía no se enviaron. */
  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Simula a la pasarela llamando al webhook del comercio, firmado, pasado un tiempo. */
  private scheduleWebhook(base: Omit<GatewayWebhookEvent, 'eventId'>, times: number): void {
    const event: GatewayWebhookEvent = { eventId: `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`, ...base };
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      for (let i = 0; i < times; i++) void this.deliver(event);
    }, this.options.webhookDelayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private async deliver(event: GatewayWebhookEvent): Promise<void> {
    const body = JSON.stringify(event);
    try {
      const response = await (this.options.fetchFn ?? fetch)(this.options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(this.options.webhookSecret, body) },
        body,
      });
      this.logger.log(`Webhook simulado ${event.type} (${event.eventId}) entregado: HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn(`No se pudo entregar el webhook simulado ${event.eventId}: ${(error as Error).message}`);
    }
  }
}
