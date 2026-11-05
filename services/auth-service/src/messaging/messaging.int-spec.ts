/**
 * El outbox de auth-service contra RabbitMQ y PostgreSQL REALES: que un evento guardado en una transacción llegue al
 * exchange compartido con la routing key que escucha notifications-service. El relay en sí (reintentos, varios en
 * paralelo, reconexión) es el mismo código que el de reservations-service y se prueba allá.
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 * Conexión: RABBITMQ_TEST_URL (por defecto amqp://guest:guest@localhost:5672) y TEST_DB_* (como las demás).
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as amqp from 'amqplib';
import { DataSource } from 'typeorm';
import { OwnerRequestEvents } from '../owner-requests/owner-request-events';
import { OutboxMessage } from './entities/outbox-message.entity';
import { EventEnvelope } from './event-envelope';
import { MessagingModule } from './messaging.module';
import { OutboxRelay } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { RabbitConnection } from './rabbit-connection';
import { EVENTS_EXCHANGE } from './topology';

const RABBIT_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:5672';
const SCHEMA = `it_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const db = (name: string, fallback: string) => process.env[`TEST_DB_${name}`] ?? fallback;

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('outbox de auth-service (RabbitMQ + PostgreSQL reales)', () => {
  const connection = {
    type: 'postgres' as const,
    host: db('HOST', 'localhost'),
    port: Number(db('PORT', '5433')),
    username: db('USER', 'auth'),
    password: db('PASSWORD', 'auth_password'),
    database: db('NAME', 'auth_db'),
  };
  let admin: DataSource;
  let moduleRef: TestingModule;
  let probe: amqp.ChannelModel;
  let channel: amqp.Channel;
  let queue: string;

  beforeAll(async () => {
    admin = await new DataSource(connection).initialize();
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);

    // Una cola temporal enlazada como la de notifications: recibe todo lo que empiece con "owner-request."
    probe = await amqp.connect(RABBIT_URL);
    channel = await probe.createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    queue = (await channel.assertQueue('', { exclusive: true })).queue;
    await channel.bindQueue(queue, EVENTS_EXCHANGE, 'owner-request.*');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          // El relay no corre solo (poll de 10 min): se llama a flush() a mano
          load: [() => ({ RABBITMQ_URL: RABBIT_URL, RABBITMQ_RETRY_MS: '100', OUTBOX_POLL_MS: '600000' })],
        }),
        TypeOrmModule.forRoot({ ...connection, schema: SCHEMA, entities: [OutboxMessage], synchronize: true }),
        MessagingModule,
      ],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef?.close();
    await probe?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.destroy();
    }
  });

  it('un evento guardado en una transacción llega a RabbitMQ y queda marcado como publicado', async () => {
    const ds = moduleRef.get(DataSource);
    const rabbit = moduleRef.get(RabbitConnection);
    await waitFor(async () => rabbit.isUp); // se conecta de fondo

    const data = { requestId: 'req-1', userId: 'user-1', restaurantName: 'La Esquina de Ana' };
    const envelope = await ds.transaction((m) => moduleRef.get(OutboxService).enqueue(m, OwnerRequestEvents.APPROVED, data));
    expect(await moduleRef.get(OutboxRelay).flush()).toBe(1);

    const message = await waitFor(async () => (await channel.get(queue, { noAck: true })) || undefined);
    expect(message.fields.routingKey).toBe('owner-request.approved');
    expect(JSON.parse(message.content.toString()) as EventEnvelope).toMatchObject({ id: envelope.id, data });

    const row = await ds.getRepository(OutboxMessage).findOneByOrFail({ id: envelope.id });
    expect(row.publishedAt).toBeInstanceOf(Date);
  });
});
