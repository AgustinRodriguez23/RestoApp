import { randomUUID } from 'node:crypto';
import { currentCorrelationId } from '../observability/request-context';

/**
 * Sobre que envuelve a todos los eventos. El `type` es también la routing key en RabbitMQ.
 * - id: identifica al mensaje (los consumidores lo usan para no procesar dos veces el mismo).
 * - correlationId: el mismo de la request HTTP que originó todo, para seguir la saga en los logs.
 */
export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  occurredAt: string;
  correlationId: string;
  data: T;
}

export function createEnvelope<T>(type: string, data: T, now = new Date()): EventEnvelope<T> {
  return {
    id: randomUUID(),
    type,
    occurredAt: now.toISOString(),
    correlationId: currentCorrelationId() ?? randomUUID(),
    data,
  };
}

/** Un mensaje que no se puede entender nunca (JSON roto, sobre incompleto): reintentarlo no sirve. */
export class InvalidMessageError extends Error {}

/** Lo lanza un handler cuando sabe que el mensaje no se va a poder procesar jamás: va directo a la DLQ. */
export class PoisonMessageError extends Error {}

export function parseEnvelope(content: Buffer): EventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new InvalidMessageError('el cuerpo no es JSON válido');
  }
  const e = parsed as Partial<EventEnvelope> | null;
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!e || typeof e !== 'object' || !isText(e.id) || !isText(e.type) || !isText(e.correlationId) || !isText(e.occurredAt)) {
    throw new InvalidMessageError('el sobre del evento está incompleto (id, type, occurredAt y correlationId son obligatorios)');
  }
  if (e.data === undefined || e.data === null || typeof e.data !== 'object') {
    throw new InvalidMessageError('el evento no trae data');
  }
  return e as EventEnvelope;
}
