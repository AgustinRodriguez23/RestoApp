import { Injectable, Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import { runWithContext } from '../observability/request-context';
import { EventEnvelope, InvalidMessageError, parseEnvelope, PoisonMessageError } from './event-envelope';
import { RabbitConnection } from './rabbit-connection';
import {
  deadLetterQueueOf,
  EVENTS_EXCHANGE,
  HEADER_ATTEMPT,
  HEADER_ERROR,
  HEADER_ORIGINAL_ROUTING_KEY,
  retryQueueOf,
} from './topology';

export interface ConsumerDefinition {
  /** Nombre del consumidor: es el nombre de la cola. */
  name: string;
  /** Tipos de evento (routing keys) que recibe, por ejemplo ['payment.succeeded', 'payment.failed']. */
  bindings: string[];
  /**
   * Procesa el evento. Tiene que ser IDEMPOTENTE por sí mismo (acá lo es por el índice único de eventId en Mongo) y
   * devolver 'duplicate' si el efecto ya se había aplicado, así se loguea como duplicado. Si lanza, se reintenta.
   */
  handler: (envelope: EventEnvelope) => Promise<'processed' | 'duplicate'>;
  /** Intentos totales antes de mandar el mensaje a la DLQ. */
  maxAttempts?: number;
  /** Espera entre intentos. */
  retryDelayMs?: number;
  prefetch?: number;
}

/**
 * Consumo confiable de eventos. Garantías, de afuera hacia adentro:
 *
 * 1. Ack manual: el mensaje se confirma recién cuando se terminó de procesar. Si el proceso muere antes,
 *    RabbitMQ lo vuelve a entregar.
 * 2. Idempotencia: la entrega es "al menos una vez", así que puede llegar repetido. A diferencia de reservations y payments
 *    (que lo resuelven con una tabla de mensajes procesados en la misma transacción SQL), acá Mongo no tiene transacciones
 *    sin un replica set, así que la idempotencia la da el índice único de la propia notificación: el handler inserta y,
 *    si el evento ya estaba, recibe un error de clave duplicada y lo informa como 'duplicate'.
 * 3. Reintentos con demora: si el handler falla, el mensaje va a `<cola>.retry` (que lo devuelve a la cola
 *    de trabajo pasado `retryDelayMs`, por TTL + dead-letter), hasta `maxAttempts` veces.
 * 4. DLQ: agotados los intentos, o si el mensaje es inválido o el handler lanza PoisonMessageError,
 *    va a `<cola>.dlq` con el motivo, para inspeccionarlo y reprocesarlo a mano. No se pierde ni se reintenta para siempre.
 */
@Injectable()
export class EventConsumers {
  private readonly logger = new Logger(EventConsumers.name);

  constructor(private readonly rabbit: RabbitConnection) {}

  private readonly ready = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  async register(def: ConsumerDefinition): Promise<void> {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.ready.set(def.name, { promise, resolve });
    await this.rabbit.onConnect((connection) => this.start(def, connection));
  }

  /** Se resuelve cuando el consumidor ya declaró sus colas y está escuchando (útil en tests y en el arranque). */
  whenReady(name: string): Promise<void> {
    return this.ready.get(name)?.promise ?? Promise.reject(new Error(`consumidor ${name} no registrado`));
  }

  private async start(def: ConsumerDefinition, connection: amqp.ChannelModel): Promise<void> {
    const channel = await connection.createChannel();
    channel.on('error', (error: Error) => this.logger.warn(`Error en el canal de ${def.name}: ${error.message}`));

    const retryDelayMs = def.retryDelayMs ?? 5000;
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    await channel.assertQueue(def.name, { durable: true });
    await channel.assertQueue(retryQueueOf(def.name), {
      durable: true,
      arguments: {
        'x-message-ttl': retryDelayMs,
        // Al vencer el TTL, el mensaje pasa al exchange por defecto con la cola de trabajo como routing key
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': def.name,
      },
    });
    await channel.assertQueue(deadLetterQueueOf(def.name), { durable: true });
    for (const binding of def.bindings) await channel.bindQueue(def.name, EVENTS_EXCHANGE, binding);

    await channel.prefetch(def.prefetch ?? 10);
    await channel.consume(def.name, (message) => {
      if (message) void this.onMessage(def, channel, message);
    });
    this.ready.get(def.name)?.resolve();
    this.logger.log(`Consumidor ${def.name} escuchando ${def.bindings.join(', ')}`);
  }

  private async onMessage(def: ConsumerDefinition, channel: amqp.Channel, message: amqp.ConsumeMessage): Promise<void> {
    const attempt = Number(message.properties.headers?.[HEADER_ATTEMPT] ?? 0);

    let envelope: EventEnvelope;
    try {
      envelope = parseEnvelope(message.content);
    } catch (error) {
      if (!(error instanceof InvalidMessageError)) throw error;
      this.logger.error(`Mensaje inválido en ${def.name}: ${error.message}`);
      await this.settle(channel, message, () => this.deadLetter(def, message, error.message, attempt + 1));
      return;
    }

    await runWithContext({ correlationId: envelope.correlationId }, async () => {
      const startedAt = Date.now();
      try {
        const outcome = await def.handler(envelope);

        if (outcome === 'processed') {
          this.logger.log(`Evento consumido: ${envelope.type} (${envelope.id}) por ${def.name} en ${Date.now() - startedAt} ms`);
        } else {
          this.logger.warn(`Evento duplicado ignorado: ${envelope.type} (${envelope.id}) en ${def.name}`);
        }
        channel.ack(message);
      } catch (error) {
        const reason = (error as Error).message;
        if (error instanceof PoisonMessageError) {
          this.logger.error(`Evento irrecuperable ${envelope.type} (${envelope.id}) en ${def.name}: ${reason}`);
          await this.settle(channel, message, () => this.deadLetter(def, message, reason, attempt + 1));
        } else if (attempt + 1 < (def.maxAttempts ?? 5)) {
          this.logger.warn(`Falló ${envelope.type} (${envelope.id}) en ${def.name}, intento ${attempt + 1}; se reintenta: ${reason}`);
          await this.settle(channel, message, () => this.retry(def, message, reason, attempt + 1));
        } else {
          this.logger.error(`Se agotaron los intentos de ${envelope.type} (${envelope.id}) en ${def.name}; va a la DLQ: ${reason}`);
          await this.settle(channel, message, () => this.deadLetter(def, message, reason, attempt + 1));
        }
      }
    });
  }

  /** Ejecuta el traslado (retry/DLQ) y recién cuando RabbitMQ lo confirmó da por resuelto el mensaje original. */
  private async settle(channel: amqp.Channel, message: amqp.ConsumeMessage, move: () => Promise<void>): Promise<void> {
    try {
      await move();
      channel.ack(message);
    } catch (error) {
      // No se pudo mover: se devuelve a la cola de trabajo para no perderlo
      this.logger.error(`No se pudo mover el mensaje: ${(error as Error).message}`);
      try {
        channel.nack(message, false, true);
      } catch {
        /* el canal ya se cerró: RabbitMQ lo reentrega solo */
      }
    }
  }

  private retry(def: ConsumerDefinition, message: amqp.ConsumeMessage, reason: string, nextAttempt: number): Promise<void> {
    return this.rabbit.publishRaw('', retryQueueOf(def.name), message.content, {
      [HEADER_ATTEMPT]: nextAttempt,
      [HEADER_ERROR]: reason.slice(0, 500),
      [HEADER_ORIGINAL_ROUTING_KEY]: message.fields.routingKey,
    });
  }

  private deadLetter(def: ConsumerDefinition, message: amqp.ConsumeMessage, reason: string, attempts: number): Promise<void> {
    return this.rabbit.publishRaw('', deadLetterQueueOf(def.name), message.content, {
      [HEADER_ATTEMPT]: attempts,
      [HEADER_ERROR]: reason.slice(0, 500),
      [HEADER_ORIGINAL_ROUTING_KEY]: message.fields.routingKey,
    });
  }
}
