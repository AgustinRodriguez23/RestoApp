import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { EventEnvelope } from './event-envelope';
import { EVENTS_EXCHANGE, HEADER_CORRELATION_ID } from './topology';

type OnConnect = (connection: amqp.ChannelModel) => Promise<void>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Conexión a RabbitMQ con reconexión automática.
 *
 * - Si RABBITMQ_URL no está definida, la mensajería queda deshabilitada (el servicio sigue andando
 *   y los eventos se acumulan en el outbox).
 * - Si el broker está caído al arrancar o se cae después, reintenta cada RABBITMQ_RETRY_MS sin tirar
 *   abajo el servicio. Quien necesita canales propios (los consumidores) se registra con `onConnect`
 *   y se vuelve a armar solo después de cada reconexión.
 * - Publica por un "confirm channel": RabbitMQ confirma que recibió el mensaje, y recién ahí se lo da por publicado.
 */
@Injectable()
export class RabbitConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitConnection.name);
  private readonly url: string | undefined;
  private readonly retryMs: number;
  private connection?: amqp.ChannelModel;
  private publisher?: amqp.ConfirmChannel;
  private readonly listeners: OnConnect[] = [];
  private closing = false;
  private connecting = false;

  constructor(config: ConfigService) {
    this.url = config.get<string>('RABBITMQ_URL') || undefined;
    this.retryMs = Number(config.get<string>('RABBITMQ_RETRY_MS') ?? 2000);
  }

  get enabled(): boolean {
    return !!this.url;
  }

  get isUp(): boolean {
    return !!this.publisher;
  }

  onModuleInit(): void {
    if (!this.url) {
      this.logger.warn('RABBITMQ_URL no está definida: la mensajería está deshabilitada');
      return;
    }
    void this.connectLoop(); // en segundo plano: el servicio arranca aunque el broker no esté
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    const connection = this.connection;
    this.connection = undefined;
    this.publisher = undefined;
    await connection?.close().catch(() => undefined);
  }

  /** Registra algo que hay que (re)armar cada vez que se conecta. Si ya hay conexión, corre enseguida. */
  async onConnect(listener: OnConnect): Promise<void> {
    this.listeners.push(listener);
    if (this.connection) await listener(this.connection);
  }

  /** Publica un objeto como JSON y espera la confirmación del broker. */
  publish(
    exchange: string,
    routingKey: string,
    body: unknown,
    headers: Record<string, unknown> = {},
    messageId?: string,
  ): Promise<void> {
    const correlationId = (body as Partial<EventEnvelope> | undefined)?.correlationId;
    return this.publishRaw(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(body)),
      { ...(correlationId ? { [HEADER_CORRELATION_ID]: correlationId } : {}), ...headers },
      messageId,
    );
  }

  /** Publica bytes tal cual (sirve para reenviar a la DLQ mensajes que ni siquiera son JSON). Lanza error si no hay conexión o el broker no confirma. */
  async publishRaw(
    exchange: string,
    routingKey: string,
    content: Buffer,
    headers: Record<string, unknown> = {},
    messageId?: string,
  ): Promise<void> {
    const channel = this.publisher;
    if (!channel) throw new Error('RabbitMQ no está conectado');
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        exchange,
        routingKey,
        content,
        {
          persistent: true, // sobrevive a un reinicio del broker (junto con colas durables)
          contentType: 'application/json',
          messageId,
          timestamp: Date.now(),
          headers,
        },
        (error) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve()),
      );
    });
  }

  /** Publica un evento en el exchange central. */
  publishEvent(envelope: EventEnvelope): Promise<void> {
    return this.publish(EVENTS_EXCHANGE, envelope.type, envelope, {}, envelope.id);
  }

  private async connectLoop(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      while (!this.closing) {
        try {
          await this.connectOnce();
          return;
        } catch (error) {
          this.logger.warn(`No se pudo conectar a RabbitMQ (${(error as Error).message}); reintento en ${this.retryMs} ms`);
          await this.dropConnection();
          await sleep(this.retryMs);
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  private async connectOnce(): Promise<void> {
    const connection = await amqp.connect(this.url as string);
    this.connection = connection;
    connection.on('error', (error: Error) => this.logger.warn(`Error en la conexión con RabbitMQ: ${error.message}`));
    connection.on('close', () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.publisher = undefined;
      if (this.closing) return;
      this.logger.warn('Se cerró la conexión con RabbitMQ; reconectando');
      void this.connectLoop();
    });

    const publisher = await connection.createConfirmChannel();
    publisher.on('error', (error: Error) => this.logger.warn(`Error en el canal de publicación: ${error.message}`));
    await publisher.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });

    this.publisher = publisher; // antes que los listeners: un consumidor puede necesitar publicar (reintentos) al instante
    for (const listener of this.listeners) await listener(connection);
    this.logger.log('Conectado a RabbitMQ');
  }

  private async dropConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.publisher = undefined;
    await connection?.close().catch(() => undefined);
  }
}
