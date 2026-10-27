import { ConfigService } from '@nestjs/config';

/** 32 caracteres: lo que da `openssl rand -hex 16` (el .env.example sugiere -hex 32). */
export const MIN_SECRET_LENGTH = 32;

/**
 * Lee un secreto obligatorio (JWT_SECRET, GATEWAY_WEBHOOK_SECRET): si falta, el servicio no arranca.
 * Con NODE_ENV=production además rechaza los débiles. Con un JWT_SECRET adivinable cualquiera firma un token
 * de otro usuario o de dueño; con el de los webhooks, un pago aprobado. En desarrollo y en los tests se acepta cualquiera.
 */
export function requireSecret(config: ConfigService, name: string): string {
  const value = config.getOrThrow<string>(name);
  if (config.get<string>('NODE_ENV') !== 'production') return value;

  if (value.startsWith('cambiame')) {
    throw new Error(`${name} todavía tiene el valor de ejemplo del .env.example. Generá uno propio: openssl rand -hex 32`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} es demasiado corto (mínimo ${MIN_SECRET_LENGTH} caracteres). Generá uno: openssl rand -hex 32`);
  }
  return value;
}
