/**
 * Integración del lado "reservas" de la saga de la seña, con PostgreSQL y RabbitMQ REALES.
 *
 * payments-service no participa acá: los eventos `payment.*` se publican a mano en RabbitMQ, igual que
 * lo haría él. Se verifica la reacción de reservations-service: estados, mesa retenida/liberada, vencimiento,
 * pagos tardíos, duplicados y eventos que quedan en el outbox.
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureApp } from '../app.setup';
import { OutboxMessage } from '../messaging/entities/outbox-message.entity';
import { createEnvelope } from '../messaging/event-envelope';
import { EVENTS_EXCHANGE, deadLetterQueueOf, retryQueueOf } from '../messaging/topology';
import { RestaurantInfo, RestaurantsClient } from '../restaurants-client/restaurants-client.service';
import { Role } from '../security/role.enum';
import { PaymentEventsConsumer } from './payment-events.consumer';
import { ReservationExpirationService } from './reservation-expiration.service';

const RABBIT_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:5672';
const RID = '64b7f0c2a1b2c3d4e5f60718';
const SCHEMA = `it_dep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `it.${Math.random().toString(36).slice(2, 8)}.`;

// Un restaurante con UNA sola mesa de 4: el hueco se llena o se libera de forma evidente
const restaurant: RestaurantInfo = {
  id: RID,
  ownerId: 'owner-1',
  name: 'Resto de una mesa',
  tables: [{ number: 1, capacity: 4 }],
  openingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opens: '10:00', closes: '23:00' })),
};

const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${day}T${hhmm}:00-03:00`;

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timeout esperando la condición');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('reservations-service: seña y saga (integración con PostgreSQL y RabbitMQ reales)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;
  let expiration: ReservationExpirationService;
  let consumer: PaymentEventsConsumer;
  let probe: amqp.ChannelModel;
  let channel: amqp.Channel;

  const bearer = (sub: string, role: Role = Role.CUSTOMER) => `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role })}`;
  const book = (customer: string, startsAt = at('20:00'), partySize = 3) =>
    request(app.getHttpServer()).post('/reservations').set('Authorization', bearer(customer)).send({ restaurantId: RID, partySize, startsAt });
  const cancel = (id: string, customer: string, role: Role = Role.CUSTOMER) =>
    request(app.getHttpServer()).post(`/reservations/${id}/cancel`).set('Authorization', bearer(customer, role));
  const get = (id: string, customer: string) =>
    request(app.getHttpServer()).get(`/reservations/${id}`).set('Authorization', bearer(customer));

  const outboxOf = (type: string, reservationId: string) =>
    ds
      .getRepository(OutboxMessage)
      .find({ where: { type } })
      .then((rows) => rows.filter((r) => (r.payload.data as { reservationId?: string }).reservationId === reservationId));

  const sendPayment = (type: 'payment.succeeded' | 'payment.failed', reservationId: string, paymentId = 'pay-1') =>
    channel.publish(
      EVENTS_EXCHANGE,
      type,
      Buffer.from(
        JSON.stringify(
          createEnvelope(type, type === 'payment.succeeded' ? { paymentId, reservationId, amountCents: 15000 } : { paymentId, reservationId, reason: 'DECLINED' }),
        ),
      ),
      { persistent: true },
    );
  const sendRaw = (type: string, envelope: unknown) =>
    channel.publish(EVENTS_EXCHANGE, type, Buffer.from(JSON.stringify(envelope)), { persistent: true });

  const status = async (id: string, customer = 'c1') => (await get(id, customer)).body.status as string;

  beforeAll(async () => {
    const env = process.env;
    Object.assign(process.env, {
      JWT_SECRET: 'integration-secret',
      DB_HOST: env.TEST_DB_HOST ?? 'localhost',
      DB_PORT: env.TEST_DB_PORT ?? '5434',
      DB_USER: env.TEST_DB_USER ?? 'reservations',
      DB_PASSWORD: env.TEST_DB_PASSWORD ?? 'reservations_password',
      DB_NAME: env.TEST_DB_NAME ?? 'reservations_db',
      DB_SCHEMA: SCHEMA,
      RESTAURANT_TIME_ZONE: 'America/Argentina/Buenos_Aires',
      NODE_ENV: 'test',
      DEPOSIT_PER_PERSON_CENTS: '5000',
      PAYMENT_WINDOW_MINUTES: '15',
      REFUND_CUTOFF_HOURS: '24',
      RABBITMQ_URL: RABBIT_URL,
      RABBITMQ_RETRY_MS: '100',
      RABBITMQ_RETRY_DELAY_MS: '100',
      RABBITMQ_QUEUE_PREFIX: PREFIX,
      OUTBOX_POLL_MS: '600000', // el relay no publica: así se pueden inspeccionar las filas del outbox
      EXPIRATION_CHECK_MS: '0', // el vencimiento se dispara a mano
    });

    const admin = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.destroy();

    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RestaurantsClient)
      .useValue({ getRestaurant: async () => restaurant })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0);
    ds = moduleRef.get(DataSource);
    jwt = moduleRef.get(JwtService);
    expiration = moduleRef.get(ReservationExpirationService);
    consumer = moduleRef.get(PaymentEventsConsumer);

    probe = await amqp.connect(RABBIT_URL);
    channel = await probe.createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    // Hasta que el consumidor no enlazó su cola, un evento publicado se perdería
    await waitFor(async () => {
      const ch = await probe.createChannel();
      ch.on('error', () => undefined);
      try {
        await ch.checkQueue(consumer.queueName);
        return true;
      } catch {
        return false;
      } finally {
        await ch.close().catch(() => undefined);
      }
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await app?.close();
    if (probe) {
      const cleaner = await probe.createChannel();
      cleaner.on('error', () => undefined);
      for (const q of [consumer.queueName, retryQueueOf(consumer.queueName), deadLetterQueueOf(consumer.queueName)]) {
        await cleaner.deleteQueue(q).catch(() => undefined);
      }
      await probe.close();
    }
  });

  beforeEach(async () => {
    await ds.query(`TRUNCATE "${SCHEMA}"."reservations", "${SCHEMA}"."outbox_messages", "${SCHEMA}"."processed_messages"`);
  });

  describe('crear', () => {
    it('nace PENDING_PAYMENT con la seña y la hora límite, y deja reservation.created en el outbox', async () => {
      const res = await book('c1');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'PENDING_PAYMENT', depositCents: 15000 });
      const expiresAt = new Date(res.body.expiresAt).getTime();
      expect(expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);

      const [event] = await outboxOf('reservation.created', res.body.id);
      expect(event.publishedAt).toBeNull();
      expect(event.payload.data).toMatchObject({
        reservationId: res.body.id,
        customerId: 'c1',
        restaurantId: RID,
        amountCents: 15000,
        currency: 'ARS',
      });
    });

    it('la mesa queda retenida mientras espera el pago: otra persona recibe 409', async () => {
      expect((await book('c1')).status).toBe(201);

      const second = await book('c2');
      expect(second.status).toBe(409);
    });

    it('la disponibilidad ya no ofrece el horario retenido', async () => {
      await book('c1', at('20:00'));

      const res = await request(app.getHttpServer())
        .get('/availability')
        .query({ restaurantId: RID, date: day, partySize: 3 });

      const starts = (res.body.slots as Array<{ startsAt: string }>).map((s) => s.startsAt);
      expect(starts).not.toContain(new Date(at('20:00')).toISOString());
      expect(starts).toContain(new Date(at('21:30')).toISOString());
    });

    it('si la transacción falla no queda ni reserva ni evento (por ejemplo, mesa ocupada → 409)', async () => {
      await book('c1');
      await book('c2');

      expect(await ds.getRepository(OutboxMessage).countBy({ type: 'reservation.created' })).toBe(1);
    });
  });

  describe('tope de reservas esperando la seña (3 por cliente)', () => {
    // Turnos de 90 min que no se pisan: con una sola mesa, lo único que decide si entran es el tope
    const slots = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30'].map(at);

    it('la cuarta pendiente da 422 con un mensaje que dice qué hacer; otro cliente no se ve afectado', async () => {
      for (const startsAt of slots.slice(0, 3)) expect((await book('c1', startsAt)).status).toBe(201);

      const fourth = await book('c1', slots[3]);
      expect(fourth.status).toBe(422);
      expect(fourth.body.message).toMatch(/esperando el pago.*Mis reservas/);
      expect((await book('c2', slots[3])).status).toBe(201);
    });

    it('cancelar una, o pagarla, libera el cupo', async () => {
      const ids: string[] = [];
      for (const startsAt of slots.slice(0, 3)) ids.push((await book('c1', startsAt)).body.id);

      await cancel(ids[0], 'c1');
      expect((await book('c1', slots[3])).status).toBe(201);

      sendPayment('payment.succeeded', ids[1]);
      await waitFor(async () => (await status(ids[1])) === 'CONFIRMED');
      expect((await book('c1', slots[4])).status).toBe(201);
    });

    it('una pendiente vencida que el job todavía no pasó a EXPIRED no ocupa cupo (ya no se puede pagar)', async () => {
      const ids: string[] = [];
      for (const startsAt of slots.slice(0, 3)) ids.push((await book('c1', startsAt)).body.id);
      await ds.query(`UPDATE "${SCHEMA}"."reservations" SET expires_at = now() - interval '1 minute' WHERE id = $1`, [ids[0]]);

      expect((await book('c1', slots[3])).status).toBe(201);
    });

    it('6 pedidos simultáneos del mismo cliente: entran exactamente 3 (el lock evita contar dos veces lo mismo)', async () => {
      const results = await Promise.all(slots.map((startsAt) => book('c1', startsAt)));

      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, 201, 201, 422, 422, 422]);
      const [{ count }] = await ds.query(
        `SELECT count(*)::int AS count FROM "${SCHEMA}"."reservations" WHERE customer_id = 'c1' AND status = 'PENDING_PAYMENT'`,
      );
      expect(count).toBe(3);
    });
  });

  describe('resultado del pago', () => {
    it('payment.succeeded confirma la reserva y emite reservation.confirmed', async () => {
      const { body } = await book('c1');

      sendPayment('payment.succeeded', body.id);

      await waitFor(async () => (await status(body.id)) === 'CONFIRMED');
      expect((await get(body.id, 'c1')).body.expiresAt).toBeNull();
      const events = await outboxOf('reservation.confirmed', body.id);
      expect(events).toHaveLength(1);
      expect(events[0].payload.data).toMatchObject({
        customerId: 'c1',
        restaurantId: RID,
        restaurantName: 'Resto de una mesa',
        partySize: 3,
        startsAt: expect.any(String),
        timeZone: expect.any(String),
      });
    });

    it('un payment.succeeded duplicado no genera dos confirmaciones', async () => {
      const { body } = await book('c1');
      const envelope = createEnvelope('payment.succeeded', { paymentId: 'pay-1', reservationId: body.id, amountCents: 15000 });

      sendRaw('payment.succeeded', envelope);
      sendRaw('payment.succeeded', envelope);
      sendRaw('payment.succeeded', envelope);
      // El consumidor procesa varios mensajes en paralelo (prefetch), así que no hay orden garantizado:
      // primero se espera la confirmación y recién después se manda la señal.
      await waitFor(async () => (await status(body.id)) === 'CONFIRMED');
      // Las copias 2 y 3 esperaban el commit de la primera (índice único de processed_messages) y se resuelven
      // enseguida. Otro evento hace de señal: cuando se procesó, esas copias ya pasaron hace rato.
      const other = await book('c2', at('21:30'));
      sendPayment('payment.succeeded', other.body.id, 'pay-2');
      await waitFor(async () => (await status(other.body.id, 'c2')) === 'CONFIRMED');

      expect(await outboxOf('reservation.confirmed', body.id)).toHaveLength(1);
    });

    it('payment.failed cancela la reserva, libera la mesa y emite reservation.cancelled (PAYMENT_FAILED)', async () => {
      const { body } = await book('c1');

      sendPayment('payment.failed', body.id);

      await waitFor(async () => (await status(body.id)) === 'CANCELLED');
      const [event] = await outboxOf('reservation.cancelled', body.id);
      expect(event.payload.data).toMatchObject({
        reason: 'PAYMENT_FAILED',
        refundable: false,
        customerId: 'c1',
        restaurantName: 'Resto de una mesa',
        partySize: 3,
        startsAt: expect.any(String),
        timeZone: expect.any(String),
      });
      expect((await get(body.id, 'c1')).body.cancelledBy).toBe('system:payment-failed');

      // La mesa volvió a estar libre
      expect((await book('c2')).status).toBe(201);
    });

    it('un pago para una reserva que no existe va a la DLQ (no se reintenta en vano)', async () => {
      sendPayment('payment.succeeded', '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10');

      const dead = await waitFor(async () => (await channel.get(deadLetterQueueOf(consumer.queueName), { noAck: true })) || undefined);
      expect(String(dead.properties.headers?.['x-error'])).toContain('no existe');
    });
  });

  describe('vencimiento', () => {
    const makeOverdue = (id: string) =>
      ds.query(`UPDATE "${SCHEMA}"."reservations" SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);

    it('vence las reservas sin pagar, libera la mesa y emite reservation.expired', async () => {
      const { body } = await book('c1');
      await makeOverdue(body.id);

      expect(await expiration.expireDue()).toEqual([body.id]);

      expect(await status(body.id)).toBe('EXPIRED');
      const events = await outboxOf('reservation.expired', body.id);
      expect(events).toHaveLength(1);
      // Con RETURNING de una lista de columnas, TypeORM solo devolvía `id` y el evento salía sin customerId (bug real)
      expect(events[0].payload.data).toMatchObject({
        reservationId: body.id,
        customerId: 'c1',
        restaurantId: RID,
        restaurantName: 'Resto de una mesa',
        partySize: 3,
        startsAt: expect.any(String),
        timeZone: expect.any(String),
      });
      expect((await book('c2')).status).toBe(201); // la mesa se liberó
    });

    it('no toca las que todavía están dentro del plazo ni las ya confirmadas', async () => {
      const waiting = await book('c1', at('20:00'));
      const paid = await book('c2', at('21:30'));
      sendPayment('payment.succeeded', paid.body.id);
      await waitFor(async () => (await status(paid.body.id, 'c2')) === 'CONFIRMED');
      await ds.query(`UPDATE "${SCHEMA}"."reservations" SET expires_at = now() - interval '1 hour' WHERE id = $1`, [paid.body.id]);

      expect(await expiration.expireDue()).toEqual([]);
      expect(await status(waiting.body.id)).toBe('PENDING_PAYMENT');
      expect(await status(paid.body.id, 'c2')).toBe('CONFIRMED');
    });

    it('dos instancias venciendo a la vez: cada reserva vence una sola vez y genera un solo evento', async () => {
      const { body } = await book('c1');
      await makeOverdue(body.id);

      const results = await Promise.all([expiration.expireDue(), expiration.expireDue(), expiration.expireDue()]);

      expect(results.flat()).toEqual([body.id]);
      expect(await outboxOf('reservation.expired', body.id)).toHaveLength(1);
    });

    it('si el pago llega DESPUÉS de vencer, la reserva sigue vencida y se pide devolver el dinero (compensación)', async () => {
      const { body } = await book('c1');
      await makeOverdue(body.id);
      await expiration.expireDue();

      sendPayment('payment.succeeded', body.id, 'pay-late');

      const refund = await waitFor(async () => {
        const rows = await outboxOf('reservation.refund_requested', body.id);
        return rows[0];
      });
      expect(refund.payload.data).toMatchObject({ paymentId: 'pay-late', reason: 'RESERVATION_EXPIRED' });
      expect(await status(body.id)).toBe('EXPIRED');
    });
  });

  describe('cancelación', () => {
    const confirmed = async (customer = 'c1', startsAt = at('20:00')) => {
      const { body } = await book(customer, startsAt);
      sendPayment('payment.succeeded', body.id);
      await waitFor(async () => (await status(body.id, customer)) === 'CONFIRMED');
      return body.id as string;
    };

    it('cancelar con anticipación emite reservation.cancelled con refundable=true', async () => {
      const id = await confirmed();

      expect((await cancel(id, 'c1')).status).toBe(200);

      const [event] = await outboxOf('reservation.cancelled', id);
      expect(event.payload.data).toMatchObject({
        reason: 'CANCELLED_BY_CUSTOMER',
        refundable: true,
        restaurantName: 'Resto de una mesa',
        startsAt: expect.any(String),
      });
    });

    it('cancelar con menos de 24 h emite refundable=false (se pierde la seña)', async () => {
      // Reserva para dentro de ~3 horas: se inserta directo porque la API exige horario del turno
      const startsAt = new Date(Date.now() + 3 * 3_600_000);
      startsAt.setUTCMinutes(Math.ceil(startsAt.getUTCMinutes() / 30) * 30, 0, 0);
      const id = (
        await ds.query(
          `INSERT INTO "${SCHEMA}"."reservations" (restaurant_id, table_number, customer_id, party_size, starts_at, ends_at, status, deposit_cents)
           VALUES ($1, 1, 'c1', 3, $2, $2::timestamptz + interval '90 minutes', 'CONFIRMED', 15000) RETURNING id`,
          [RID, startsAt],
        )
      )[0].id as string;

      expect((await cancel(id, 'c1')).status).toBe(200);

      const [event] = await outboxOf('reservation.cancelled', id);
      expect(event.payload.data).toMatchObject({ refundable: false });
    });

    it('si cancela el dueño, refundable=true', async () => {
      const id = await confirmed();

      expect((await cancel(id, 'owner-1', Role.RESTAURANT_OWNER)).status).toBe(200);

      const [event] = await outboxOf('reservation.cancelled', id);
      expect(event.payload.data).toMatchObject({ reason: 'CANCELLED_BY_OWNER', refundable: true });
    });

    it('se puede cancelar mientras espera el pago, y el pago que llega después pide devolución', async () => {
      const { body } = await book('c1');
      expect((await cancel(body.id, 'c1')).status).toBe(200);
      expect(await status(body.id)).toBe('CANCELLED');

      sendPayment('payment.succeeded', body.id, 'pay-after-cancel');

      const refund = await waitFor(async () => (await outboxOf('reservation.refund_requested', body.id))[0]);
      expect(refund.payload.data).toMatchObject({ paymentId: 'pay-after-cancel', reason: 'RESERVATION_CANCELLED' });
    });
  });
});
