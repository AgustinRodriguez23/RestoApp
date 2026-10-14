/**
 * Pruebas de integración de la mensajería contra RabbitMQ y PostgreSQL REALES.
 *
 * Qué demuestran: que el outbox, la idempotencia, los reintentos y la DLQ funcionan de verdad con un
 * broker real (no con mocks): duplicados, fallos transitorios, mensajes venenosos, varios relays en
 * paralelo y reconexión.
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 * Conexión: RABBITMQ_TEST_URL (por defecto amqp://guest:guest@localhost:5672) y TEST_DB_* (como las demás).
 */
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as amqp from 'amqplib';
import { DataSource } from 'typeorm';
import { currentCorrelationId } from '../observability/request-context';
import { OutboxMessage } from './entities/outbox-message.entity';
import { ProcessedMessage } from './entities/processed-message.entity';
import { ConsumerDefinition, EventConsumers } from './event-consumers.service';
import { createEnvelope, EventEnvelope, PoisonMessageError } from './event-envelope';
import { MessagingModule } from './messaging.module';
import { OutboxRelay } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { RabbitConnection } from './rabbit-connection';
import { deadLetterQueueOf, EVENTS_EXCHANGE, HEADER_ATTEMPT, HEADER_ERROR } from './topology';

const RABBIT_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:5672';
const SCHEMA = `it_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const RUN = Math.random().toString(36).slice(2, 8);
const db = (name: string, fallback: string) => process.env[`TEST_DB_${name}`] ?? fallback;

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('mensajería (RabbitMQ + PostgreSQL reales)', () => {
  let admin: DataSource;
  let probe: amqp.ChannelModel;
  let probeChannel: amqp.Channel;
  const apps: TestingModule[] = [];
  const queues: string[] = [];

  const connectionOptions = () => ({
    type: 'postgres' as const,
    host: db('HOST', 'localhost'),
    port: Number(db('PORT', '5435')),
    username: db('USER', 'payments'),
    password: db('PASSWORD', 'payments_password'),
    database: db('NAME', 'payments_db'),
  });

  async function buildModule(env: Record<string, string> = {}) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ RABBITMQ_URL: RABBIT_URL, RABBITMQ_RETRY_MS: '100', OUTBOX_POLL_MS: '600000', ...env })],
        }),
        TypeOrmModule.forRoot({
          ...connectionOptions(),
          schema: SCHEMA,
          entities: [OutboxMessage, ProcessedMessage],
          synchronize: true,
        }),
        MessagingModule,
      ],
    }).compile();
    await moduleRef.init();
    apps.push(moduleRef);
    return {
      moduleRef,
      ds: moduleRef.get(DataSource),
      outbox: moduleRef.get(OutboxService),
      relay: moduleRef.get(OutboxRelay),
      consumers: moduleRef.get(EventConsumers),
      rabbit: moduleRef.get(RabbitConnection),
    };
  }

  const queueName = (label: string) => {
    const name = `it.${RUN}.${label}`;
    queues.push(name);
    return name;
  };

  /** Publica directo al exchange, sin pasar por el outbox (para simular mensajes que llegan de afuera). */
  const publishDirect = (type: string, envelope: unknown) =>
    probeChannel.publish(EVENTS_EXCHANGE, type, Buffer.from(JSON.stringify(envelope)), { persistent: true });

  /** Registra un consumidor y espera a que esté escuchando (si no, un mensaje publicado antes se perdería: no había cola enlazada). */
  const register = async (consumers: EventConsumers, def: ConsumerDefinition) => {
    await consumers.register(def);
    await consumers.whenReady(def.name);
  };

  const dlqMessage = async (queue: string) =>
    waitFor(async () => (await probeChannel.get(deadLetterQueueOf(queue), { noAck: true })) || undefined, 8000);

  beforeAll(async () => {
    admin = await new DataSource(connectionOptions()).initialize();
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    probe = await amqp.connect(RABBIT_URL);
    probeChannel = await probe.createChannel();
    await probeChannel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  });

  afterEach(async () => {
    while (apps.length) await apps.pop()?.close();
  });

  afterAll(async () => {
    if (probe) {
      const cleaner = await probe.createChannel();
      cleaner.on('error', () => undefined);
      for (const q of queues) {
        for (const name of [q, `${q}.retry`, `${q}.dlq`]) await cleaner.deleteQueue(name).catch(() => undefined);
      }
      await probe.close();
    }
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.destroy();
    }
  });

  it('flujo completo: outbox → relay → RabbitMQ → consumidor, con el mismo correlationId', async () => {
    const { ds, outbox, relay, consumers } = await buildModule();
    const queue = queueName('e2e');
    const seen: Array<{ envelope: EventEnvelope; ctxCorrelation?: string }> = [];
    await register(consumers, {
      name: queue,
      bindings: ['demo.happened'],
      handler: async (envelope) => {
        seen.push({ envelope, ctxCorrelation: currentCorrelationId() });
      },
    });

    const envelope = await ds.transaction((m) => outbox.enqueue(m, 'demo.happened', { n: 1 }));
    expect(await relay.flush()).toBe(1);

    await waitFor(() => seen.length === 1);
    expect(seen[0].envelope).toMatchObject({ id: envelope.id, type: 'demo.happened', data: { n: 1 } });
    expect(seen[0].ctxCorrelation).toBe(envelope.correlationId);

    const row = await ds.getRepository(OutboxMessage).findOneByOrFail({ id: envelope.id });
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(await ds.getRepository(ProcessedMessage).countBy({ consumer: queue })).toBe(1);
  });

  it('si la transacción se revierte, el evento no existe (ni se publica)', async () => {
    const { ds, outbox, relay } = await buildModule();

    await expect(
      ds.transaction(async (m) => {
        await outbox.enqueue(m, 'demo.rolledback', { n: 1 });
        throw new Error('falló el negocio');
      }),
    ).rejects.toThrow('falló el negocio');

    expect(await ds.getRepository(OutboxMessage).countBy({ type: 'demo.rolledback' })).toBe(0);
    await relay.flush();
  });

  it('un mensaje duplicado se procesa una sola vez', async () => {
    const { consumers, ds } = await buildModule();
    const queue = queueName('dup');
    const handler = jest.fn(async () => undefined);
    await register(consumers, { name: queue, bindings: ['demo.dup'], handler });

    const envelope = createEnvelope('demo.dup', { n: 1 });
    for (let i = 0; i < 3; i++) publishDirect('demo.dup', envelope);
    publishDirect('demo.dup', createEnvelope('demo.dup', { n: 2 })); // otro mensaje distinto, como señal de "ya terminó"

    await waitFor(() => handler.mock.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await ds.getRepository(ProcessedMessage).countBy({ consumer: queue })).toBe(2);
  });

  it('el efecto y el registro de "procesado" son atómicos: si el handler falla, nada queda a medias', async () => {
    const { consumers, ds } = await buildModule();
    const queue = queueName('atomic');
    let calls = 0;
    await register(consumers, {
      name: queue,
      bindings: ['demo.atomic'],
      retryDelayMs: 100,
      handler: async (_envelope, manager) => {
        calls++;
        await manager.insert(OutboxMessage, { id: randomUUID(), type: 'side.effect', payload: createEnvelope('x', {}) as never });
        if (calls === 1) throw new Error('falla transitoria');
      },
    });

    publishDirect('demo.atomic', createEnvelope('demo.atomic', {}));
    await waitFor(() => calls === 2);
    await waitFor(async () => (await ds.getRepository(ProcessedMessage).countBy({ consumer: queue })) === 1);

    // El efecto del primer intento (fallido) se revirtió: solo existe el del segundo
    expect(await ds.getRepository(OutboxMessage).countBy({ type: 'side.effect' })).toBe(1);
  });

  it('un fallo transitorio se reintenta con demora y termina bien, sin pasar por la DLQ', async () => {
    const { consumers } = await buildModule();
    const queue = queueName('retry');
    const attempts: number[] = [];
    await register(consumers, {
      name: queue,
      bindings: ['demo.flaky'],
      maxAttempts: 5,
      retryDelayMs: 150,
      handler: async () => {
        attempts.push(Date.now());
        if (attempts.length < 3) throw new Error('todavía no');
      },
    });

    publishDirect('demo.flaky', createEnvelope('demo.flaky', {}));
    await waitFor(() => attempts.length === 3);

    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(140); // respetó la demora
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(140);
    await new Promise((r) => setTimeout(r, 200));
    expect(await probeChannel.get(deadLetterQueueOf(queue), { noAck: true })).toBe(false);
  });

  it('si se agotan los intentos, el mensaje va a la DLQ con el motivo y deja de reintentarse', async () => {
    const { consumers, ds } = await buildModule();
    const queue = queueName('exhaust');
    const handler = jest.fn(async () => {
      throw new Error('siempre falla');
    });
    await register(consumers, { name: queue, bindings: ['demo.broken'], maxAttempts: 3, retryDelayMs: 80, handler });

    const envelope = createEnvelope('demo.broken', { n: 7 });
    publishDirect('demo.broken', envelope);

    const dead = await dlqMessage(queue);
    expect(JSON.parse(dead.content.toString())).toMatchObject({ id: envelope.id, data: { n: 7 } });
    expect(dead.properties.headers?.[HEADER_ERROR]).toBe('siempre falla');
    expect(dead.properties.headers?.[HEADER_ATTEMPT]).toBe(3);

    await new Promise((r) => setTimeout(r, 300));
    expect(handler).toHaveBeenCalledTimes(3);
    expect(await ds.getRepository(ProcessedMessage).countBy({ consumer: queue })).toBe(0);
  });

  it('un mensaje venenoso (PoisonMessageError) va directo a la DLQ, sin reintentos', async () => {
    const { consumers } = await buildModule();
    const queue = queueName('poison');
    const handler = jest.fn(async () => {
      throw new PoisonMessageError('el pago no existe');
    });
    await register(consumers, { name: queue, bindings: ['demo.poison'], retryDelayMs: 80, handler });

    publishDirect('demo.poison', createEnvelope('demo.poison', {}));

    const dead = await dlqMessage(queue);
    expect(dead.properties.headers?.[HEADER_ERROR]).toBe('el pago no existe');
    await new Promise((r) => setTimeout(r, 250));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('mensajes inválidos (no JSON, sobre incompleto) van a la DLQ sin llamar al handler', async () => {
    const { consumers } = await buildModule();
    const queue = queueName('invalid');
    const handler = jest.fn(async () => undefined);
    await register(consumers, { name: queue, bindings: ['demo.invalid'], handler });

    probeChannel.publish(EVENTS_EXCHANGE, 'demo.invalid', Buffer.from('esto no es json'), { persistent: true });
    publishDirect('demo.invalid', { type: 'demo.invalid', data: {} }); // sin id ni correlationId

    const first = await dlqMessage(queue);
    const second = await dlqMessage(queue);
    expect(first.content.toString()).toBe('esto no es json');
    expect(String(first.properties.headers?.[HEADER_ERROR])).toContain('JSON');
    expect(String(second.properties.headers?.[HEADER_ERROR])).toContain('incompleto');
    expect(handler).not.toHaveBeenCalled();
  });

  it('si RabbitMQ rechaza o no está, el evento queda pendiente con backoff y se publica más tarde', async () => {
    const { ds, outbox, relay, rabbit, consumers } = await buildModule();
    await ds.getRepository(OutboxMessage).clear(); // sin pendientes de otros tests
    const queue = queueName('backoff');
    const handler = jest.fn(async () => undefined);
    await register(consumers, { name: queue, bindings: ['demo.later'], handler });
    await waitFor(() => rabbit.isUp);

    const envelope = await ds.transaction((m) => outbox.enqueue(m, 'demo.later', {}));
    const spy = jest.spyOn(rabbit, 'publishEvent').mockRejectedValueOnce(new Error('broker caído'));

    expect(await relay.flush()).toBe(0);
    let row = await ds.getRepository(OutboxMessage).findOneByOrFail({ id: envelope.id });
    expect(row).toMatchObject({ publishedAt: null, attempts: 1, lastError: 'broker caído' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    expect(await relay.flush()).toBe(0); // todavía no toca reintentar
    await ds.getRepository(OutboxMessage).update({ id: envelope.id }, { nextAttemptAt: new Date(Date.now() - 1000) });
    expect(await relay.flush()).toBe(1);
    spy.mockRestore();

    await waitFor(() => handler.mock.calls.length === 1);
    row = await ds.getRepository(OutboxMessage).findOneByOrFail({ id: envelope.id });
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it('varios relays en paralelo no publican nunca dos veces lo mismo (SKIP LOCKED)', async () => {
    const a = await buildModule({ OUTBOX_BATCH_SIZE: '7' });
    const b = await buildModule({ OUTBOX_BATCH_SIZE: '7' });
    await a.ds.getRepository(OutboxMessage).clear();
    const queue = queueName('parallel');
    const received: string[] = [];
    await register(a.consumers, {
      name: queue,
      bindings: ['demo.parallel'],
      handler: async (envelope) => {
        received.push(envelope.id);
      },
    });
    await waitFor(() => a.rabbit.isUp && b.rabbit.isUp);

    const ids = await a.ds.transaction(async (m) => {
      const out: string[] = [];
      for (let i = 0; i < 30; i++) out.push((await a.outbox.enqueue(m, 'demo.parallel', { i })).id);
      return out;
    });

    const published: number[] = [];
    for (let round = 0; round < 3; round++) {
      published.push(...(await Promise.all([a.relay.flush(), b.relay.flush(), a.relay.flush()])));
    }
    expect(published.reduce((x, y) => x + y, 0)).toBe(30);

    await waitFor(() => received.length >= 30);
    await new Promise((r) => setTimeout(r, 200));
    expect([...received].sort()).toEqual([...ids].sort());
  });

  it('un relay no espera a otro: si alguien tiene una fila bloqueada, publica las demás sin bloquearse (SKIP LOCKED)', async () => {
    const { ds, outbox, relay, consumers, rabbit } = await buildModule();
    await ds.getRepository(OutboxMessage).clear();
    const queue = queueName('skiplocked');
    const received: string[] = [];
    await register(consumers, {
      name: queue,
      bindings: ['demo.locked'],
      handler: async (envelope) => {
        received.push(envelope.id);
      },
    });
    await waitFor(() => rabbit.isUp);

    const [locked, free] = await ds.transaction(async (m) => [
      await outbox.enqueue(m, 'demo.locked', { n: 1 }),
      await outbox.enqueue(m, 'demo.locked', { n: 2 }),
    ]);

    // Otra "instancia" tiene tomada la primera fila (transacción abierta con FOR UPDATE)
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.manager
      .createQueryBuilder(OutboxMessage, 'o')
      .setLock('pessimistic_write')
      .where('o.id = :id', { id: locked.id })
      .getOneOrFail();

    try {
      const outcome = await Promise.race([
        relay.flush().then((n) => ({ published: n })),
        new Promise<{ blocked: true }>((resolve) => setTimeout(() => resolve({ blocked: true }), 3000)),
      ]);
      expect(outcome).toEqual({ published: 1 }); // no se quedó esperando al otro
      await waitFor(() => received.length === 1);
      expect(received).toEqual([free.id]);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
    }

    expect(await relay.flush()).toBe(1); // al soltarse, la fila bloqueada se publica
    await waitFor(() => received.length === 2);
  });

  it('el relay automático publica solo, sin que nadie llame a flush()', async () => {
    const { ds, outbox, consumers } = await buildModule({ OUTBOX_POLL_MS: '50' });
    const queue = queueName('auto');
    const handler = jest.fn(async () => undefined);
    await register(consumers, { name: queue, bindings: ['demo.auto'], handler });

    await ds.transaction((m) => outbox.enqueue(m, 'demo.auto', {}));
    await waitFor(() => handler.mock.calls.length === 1);
  });

  it('si se corta la conexión, reconecta y el consumidor sigue funcionando', async () => {
    const { rabbit, consumers, ds, outbox, relay } = await buildModule();
    const queue = queueName('reconnect');
    const handler = jest.fn(async () => undefined);
    await register(consumers, { name: queue, bindings: ['demo.reconnect'], handler });
    await waitFor(() => rabbit.isUp);

    const connection = (rabbit as unknown as { connection: amqp.ChannelModel }).connection;
    await connection.close(); // simula la caída
    expect(rabbit.isUp).toBe(false);
    await waitFor(() => rabbit.isUp);

    await ds.transaction((m) => outbox.enqueue(m, 'demo.reconnect', {}));
    await relay.flush();
    await waitFor(() => handler.mock.calls.length === 1);
  });

  it('con RABBITMQ_URL vacía la mensajería queda deshabilitada y no rompe nada', async () => {
    const { rabbit, relay } = await buildModule({ RABBITMQ_URL: '' });
    expect(rabbit.enabled).toBe(false);
    expect(await relay.flush()).toBe(0);
  });
});
