import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidWebhookError } from './payment-gateway';

/** Cuánto puede diferir el reloj del emisor del nuestro. Evita que alguien reenvíe un webhook viejo capturado. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const SIGNATURE_HEADER = 'x-gateway-signature';

/**
 * Firma HMAC-SHA256 estilo Stripe: `t=<unix>,v1=<hex>` donde hex = HMAC(secreto, `${t}.${cuerpo}`).
 * Incluir el timestamp en lo firmado impide reutilizar la firma con otra fecha.
 */
export function signWebhook(secret: string, rawBody: Buffer | string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | string[] | undefined,
  now = Math.floor(Date.now() / 1000),
): void {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new InvalidWebhookError('falta la firma del webhook');

  const parts = Object.fromEntries(
    value.split(',').map((part) => {
      const [k, ...rest] = part.trim().split('=');
      return [k, rest.join('=')];
    }),
  );
  const timestamp = Number(parts.t);
  const received = parts.v1;
  if (!Number.isInteger(timestamp) || !received) throw new InvalidWebhookError('la firma del webhook tiene un formato inválido');

  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new InvalidWebhookError('la firma del webhook está vencida');
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const actual = Buffer.from(received, 'hex');
  // timingSafeEqual: compara en tiempo constante (no revela cuántos bytes coinciden) y exige igual largo
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvalidWebhookError('la firma del webhook no coincide');
  }
}
