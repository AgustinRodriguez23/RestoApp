/**
 * Integración del consumo contra RabbitMQ REAL (no hace falta MongoDB: la bandeja se simula en memoria con la misma
 * garantía de idempotencia que da el índice único de eventId).
 *
 * Qué demuestra: que un evento publicado en el exchange central termina en una notificación, que los repetidos no la
 * duplican, que un fallo transitorio se reintenta, que un evento imposible de procesar va a la DLQ con el motivo y que
 * los eventos que no le interesan a este servicio ni siquiera llegan a su cola.
 *
 * Cómo correrla:  npm run infra:up  y después  npm run test:integration -w notifications-service
 * Conexión: RABBITMQ_TEST_URL (por defecto amqp://guest:guest@localhost:5672).
 */
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { NotificationDraft } from '../notifications/notification-templates';
import { NotificationEventsConsumer } from '../notifications/notification-events.consumer';
import { NotificationsService } from '../notifications/notifications.service';
import { EventConsumers } from './event-consumers.service';
import { MessagingModule } from './messaging.module';
import { deadLetterQueueOf, EVENTS_EXCHANGE, HEADER_ATTEMPT, HEADER_ERROR } from './topology';

const RABBIT_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:5672';
const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `it.${RUN}.`;
const QUEUE = `${PREFIX}notifications-service.reservations`;

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bandeja en memoria: idempotente por eventId, como el índice único de Mongo. */
class FakeInbox {
  stored = new Map<string, NotificationDraft>();
  attempts = 0;
  failNext = 0;
  async createFromEvent(eventId: string, draft: NotificationDraft): Promise<'created' | 'duplicate'> {
    this.attempts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('mongo no disponible (simulado)');
    }
    if (this.stored.has(eventId)) return 'duplicate';
    this.stored.set(eventId, draft);
    return 'created';
  }
}

const event = (type: string, data: Record<string, unknown>) => ({
  id: randomUUID(),
  type,
  occurredAt: new Date().toISOString(),
  correlationId: randomUUID(),
  data,
});
const confirmed = (overrides: Record<string, unknown> = {}) =>
  event('reservation.confirmed', {
    reservationId: 'res-1',
    customerId: 'cust-1',
    restaurantId: 'rest-1',
    restaurantName: 'La Parrilla',
    startsAt: '2026-11-01T00:30:00.000Z',
    partySize: 2,
    timeZone: 'America/Argentina/Buenos_Aires',
    ...overrides,
  });

describe('notifications-service: consumo de eventos (RabbitMQ real)', () => {
  let probe: amqp.ChannelModel;
  let channel: amqp.Channel;
  let inbox: FakeInbox;
  let moduleRef: TestingModule;

  const publish = (type: string, body: unknown) =>
    channel.publish(EVENTS_EXCHANGE, type, Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), { persistent: true });
  const dlq = () => waitFor(async () => (await channel.get(deadLetterQueueOf(QUEUE), { noAck: true })) || undefined);
  const queueDepth = async (name: string) => (await channel.checkQueue(name)).messageCount;

  beforeAll(async () => {
    probe = await amqp.connect(RABBIT_URL);
    channel = await probe.createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  });

  beforeEach(async () => {
    inbox = new FakeInbox();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              RABBITMQ_URL: RABBIT_URL,
              RABBITMQ_RETRY_MS: '100',
              RABBITMQ_RETRY_DELAY_MS: '150',
              RABBITMQ_QUEUE_PREFIX: PREFIX,
            }),
          ],
        }),
        MessagingModule,
      ],
      providers: [{ provide: NotificationsService, useValue: inbox }, NotificationEventsConsumer],
    }).compile();
    await moduleRef.init();
    await moduleRef.get(EventConsumers).whenReady(QUEUE);
  });

  afterEach(async () => {
    await moduleRef.close();
    // cola y auxiliares vacías para el próximo caso (la cola es la misma entre casos)
    for (const q of [QUEUE, `${QUEUE}.retry`, deadLetterQueueOf(QUEUE)]) await channel.purgeQueue(q).catch(() => undefined);
  });

  afterAll(async () => {
    const cleaner = await probe.createChannel();
    cleaner.on('error', () => undefined);
    for (const q of [QUEUE, `${QUEUE}.retry`, deadLetterQueueOf(QUEUE)]) await cleaner.deleteQueue(q).catch(() => undefined);
    await probe.close();
  });

  it('un evento reservation.confirmed publicado en el exchange termina en una notificación para el cliente', async () => {
    const e = confirmed();
    publish(e.type, e);

    await waitFor(() => inbox.stored.has(e.id));
    expect(inbox.stored.get(e.id)).toMatchObject({
      userId: 'cust-1',
      type: 'RESERVATION_CONFIRMED',
      title: 'Reserva confirmada',
      body: 'Tu mesa en La Parrilla para 2 personas el sábado 31 de octubre a las 21:30 está confirmada.',
    });
  });

  it('el mismo evento entregado tres veces crea UNA sola notificación', async () => {
    const e = confirmed();
    publish(e.type, e);
    publish(e.type, e);
    publish(e.type, e);

    await waitFor(() => inbox.attempts >= 3);
    expect(inbox.stored.size).toBe(1);
    expect(await queueDepth(deadLetterQueueOf(QUEUE))).toBe(0); // un duplicado no es un error
  });

  it('cada evento distinto genera su propia notificación', async () => {
    const [a, b] = [confirmed({ reservationId: 'res-a' }), event('reservation.expired', { reservationId: 'res-b', customerId: 'cust-2', restaurantId: 'rest-1' })];
    publish(a.type, a);
    publish(b.type, b);

    await waitFor(() => inbox.stored.size === 2);
    expect(inbox.stored.get(b.id)).toMatchObject({ userId: 'cust-2', type: 'RESERVATION_EXPIRED' });
  });

  it('si canceló el propio cliente no se crea nada y el mensaje se consume igual (no queda en la cola)', async () => {
    const e = event('reservation.cancelled', { reservationId: 'res-1', customerId: 'cust-1', restaurantId: 'rest-1', reason: 'CANCELLED_BY_CUSTOMER' });
    publish(e.type, e);

    await waitFor(async () => (await queueDepth(QUEUE)) === 0 && (await queueDepth(deadLetterQueueOf(QUEUE))) === 0);
    await sleep(150);
    expect(inbox.attempts).toBe(0);
    expect(inbox.stored.size).toBe(0);
  });

  it('un fallo transitorio de la base se reintenta con demora y termina bien, sin pasar por la DLQ', async () => {
    inbox.failNext = 2;
    const e = confirmed();
    publish(e.type, e);

    await waitFor(() => inbox.stored.has(e.id), 10_000);
    expect(inbox.attempts).toBe(3); // falló 2 veces y la tercera funcionó
    expect(await queueDepth(deadLetterQueueOf(QUEUE))).toBe(0);
  });

  it('si la base nunca se recupera, tras agotar los intentos va a la DLQ con el motivo', async () => {
    inbox.failNext = 99;
    const e = confirmed();
    publish(e.type, e);

    const message = await dlq();
    expect(message.properties.headers?.[HEADER_ERROR]).toContain('mongo no disponible');
    expect(message.properties.headers?.[HEADER_ATTEMPT]).toBe(5);
    expect(inbox.stored.size).toBe(0);
  }, 20_000);

  it('un evento sin customerId es imposible de procesar: va directo a la DLQ, sin reintentos', async () => {
    const e = confirmed({ customerId: undefined });
    publish(e.type, e);

    const message = await dlq();
    expect(message.properties.headers?.[HEADER_ERROR]).toMatch(/no se sabe a quién avisar/);
    expect(message.properties.headers?.[HEADER_ATTEMPT]).toBe(1);
    expect(inbox.attempts).toBe(0);
  });

  it('un mensaje que ni siquiera es JSON va a la DLQ sin llamar a la base', async () => {
    publish('reservation.confirmed', Buffer.from('esto no es json'));

    const message = await dlq();
    expect(message.properties.headers?.[HEADER_ERROR]).toMatch(/JSON/);
    expect(inbox.attempts).toBe(0);
  });

  it('los eventos que no le interesan (reservation.created, payment.succeeded) ni llegan a su cola', async () => {
    publish('reservation.created', event('reservation.created', { reservationId: 'res-1', customerId: 'cust-1' }));
    publish('payment.succeeded', event('payment.succeeded', { paymentId: 'p', reservationId: 'res-1' }));
    const marker = confirmed(); // este sí: al verlo procesado sabemos que los anteriores ya pasaron por el broker
    publish(marker.type, marker);

    await waitFor(() => inbox.stored.has(marker.id));
    expect(inbox.attempts).toBe(1);
    expect(await queueDepth(deadLetterQueueOf(QUEUE))).toBe(0);
  });
});
