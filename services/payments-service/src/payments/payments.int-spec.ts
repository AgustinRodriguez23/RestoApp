/**
 * Integración de payments-service con PostgreSQL y RabbitMQ REALES y la pasarela simulada (con sus webhooks
 * reales: la pasarela llama por HTTP al propio servicio).
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 * Conexión: TEST_DB_* (por defecto localhost:5435, usuario payments) y RABBITMQ_TEST_URL.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureApp } from '../app.setup';
import { GatewayUnavailableError, PAYMENT_GATEWAY, PaymentGateway } from '../gateway/payment-gateway';
import { signWebhook, SIGNATURE_HEADER } from '../gateway/webhook-signature';
import { OutboxMessage } from '../messaging/entities/outbox-message.entity';
import { createEnvelope } from '../messaging/event-envelope';
import { EVENTS_EXCHANGE, deadLetterQueueOf, retryQueueOf } from '../messaging/topology';
import { Role } from '../security/role.enum';
import { GatewayEvent } from './entities/gateway-event.entity';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { ReservationEventsConsumer } from './reservation-events.consumer';

const RABBIT_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:5672';
const SCHEMA = `it_pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `it.${Math.random().toString(36).slice(2, 8)}.`;
const SECRET = 'whsec_integration';
const PORT = 38000 + Math.floor(Math.random() * 1000);
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

describe('payments-service (integración con PostgreSQL, RabbitMQ y pasarela simulada)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;
  let gateway: PaymentGateway;
  let consumer: ReservationEventsConsumer;
  let probe: amqp.ChannelModel;
  let channel: amqp.Channel;

  const bearer = (sub: string) => `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role: Role.CUSTOMER })}`;
  const pay = (paymentId: string, token: string, key = randomUUID(), user = 'c1') =>
    request(app.getHttpServer()).post(`/payments/${paymentId}/pay`).set('Authorization', bearer(user)).set('Idempotency-Key', key).send({ token });
  const getPayment = (id: string, user = 'c1') => request(app.getHttpServer()).get(`/payments/${id}`).set('Authorization', bearer(user));
  const statusOf = async (id: string) => (await ds.getRepository(Payment).findOneByOrFail({ id })).status;

  const seed = async (overrides: Partial<Payment> = {}) =>
    ds.getRepository(Payment).save(
      ds.getRepository(Payment).create({
        reservationId: randomUUID(),
        customerId: 'c1',
        restaurantId: '64b7f0c2a1b2c3d4e5f60718',
        amountCents: 15000,
        currency: 'ARS',
        status: PaymentStatus.PENDING,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        ...overrides,
      }),
    );

  const outboxOf = (type: string, paymentId?: string) =>
    ds
      .getRepository(OutboxMessage)
      .find({ where: { type } })
      .then((rows) => rows.filter((r) => !paymentId || (r.payload.data as { paymentId?: string }).paymentId === paymentId));

  const send = (type: string, data: object) =>
    channel.publish(EVENTS_EXCHANGE, type, Buffer.from(JSON.stringify(createEnvelope(type, data))), { persistent: true });
  const sendEnvelope = (type: string, envelope: unknown) =>
    channel.publish(EVENTS_EXCHANGE, type, Buffer.from(JSON.stringify(envelope)), { persistent: true });

  beforeAll(async () => {
    const env = process.env;
    Object.assign(process.env, {
      JWT_SECRET: 'integration-secret',
      DB_HOST: db('HOST', 'localhost'),
      DB_PORT: db('PORT', '5435'),
      DB_USER: db('USER', 'payments'),
      DB_PASSWORD: db('PASSWORD', 'payments_password'),
      DB_NAME: db('NAME', 'payments_db'),
      DB_SCHEMA: SCHEMA,
      NODE_ENV: 'test',
      PORT: String(PORT),
      PAYMENT_PROVIDER: 'simulated',
      GATEWAY_WEBHOOK_SECRET: SECRET,
      SIMULATED_WEBHOOK_DELAY_MS: '150',
      RABBITMQ_URL: RABBIT_URL,
      RABBITMQ_RETRY_MS: '100',
      RABBITMQ_RETRY_DELAY_MS: '100',
      RABBITMQ_QUEUE_PREFIX: PREFIX,
      OUTBOX_POLL_MS: '600000', // el relay no publica: así se inspeccionan las filas del outbox
    });
    void env;

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.listen(PORT);
    ds = moduleRef.get(DataSource);
    jwt = moduleRef.get(JwtService);
    gateway = moduleRef.get(PAYMENT_GATEWAY);
    consumer = moduleRef.get(ReservationEventsConsumer);

    probe = await amqp.connect(RABBIT_URL);
    channel = await probe.createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
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
    jest.restoreAllMocks();
    await ds.query(
      `TRUNCATE "${SCHEMA}"."payments", "${SCHEMA}"."outbox_messages", "${SCHEMA}"."processed_messages", "${SCHEMA}"."idempotency_keys", "${SCHEMA}"."gateway_events"`,
    );
  });

  it('GET /health responde ok con la base y RabbitMQ conectados', async () => {
    await waitFor(async () => (await request(app.getHttpServer()).get('/health')).body.messaging === 'up');
    const res = await request(app.getHttpServer()).get('/health');

    expect(res.body).toMatchObject({ status: 'ok', service: 'payments-service', database: 'up', messaging: 'up' });
  });

  describe('reservation.created → pago pendiente', () => {
    it('crea el pago PENDING con el importe y el plazo de la reserva', async () => {
      const reservationId = randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

      send('reservation.created', { reservationId, customerId: 'c1', restaurantId: '64b7f0c2a1b2c3d4e5f60718', amountCents: 15000, currency: 'ARS', expiresAt });

      const res = await waitFor(async () => {
        const r = await request(app.getHttpServer()).get(`/payments/by-reservation/${reservationId}`).set('Authorization', bearer('c1'));
        return r.status === 200 ? r : undefined;
      });
      expect(res.body).toMatchObject({ reservationId, amountCents: 15000, currency: 'ARS', status: 'PENDING', expiresAt });
    });

    it('un evento duplicado no crea un segundo pago', async () => {
      const reservationId = randomUUID();
      const envelope = createEnvelope('reservation.created', {
        reservationId, customerId: 'c1', restaurantId: '64b7f0c2a1b2c3d4e5f60718', amountCents: 15000, currency: 'ARS', expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });

      sendEnvelope('reservation.created', envelope);
      sendEnvelope('reservation.created', envelope);
      // Mismo contenido pero OTRO mensaje (otro id): la restricción única de reservationId lo frena igual
      send('reservation.created', envelope.data as object);

      await waitFor(async () => (await ds.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."processed_messages"`))[0].n === 2);
      expect(await ds.getRepository(Payment).countBy({ reservationId })).toBe(1);
    });

    it('otro usuario no ve el pago (404)', async () => {
      const p = await seed();

      expect((await getPayment(p.id, 'c2')).status).toBe(404);
      expect((await request(app.getHttpServer()).get(`/payments/by-reservation/${p.reservationId}`).set('Authorization', bearer('c2'))).status).toBe(404);
    });

    it('GET /payments?reservationIds= trae en un pedido los pagos propios, y nada de lo ajeno ni de lo que no existe', async () => {
      const [a, b] = [await seed(), await seed({ status: PaymentStatus.SUCCEEDED })];
      const foreign = await seed({ customerId: 'c2' });

      const res = await request(app.getHttpServer())
        .get('/payments')
        .query({ reservationIds: [a.reservationId, b.reservationId, foreign.reservationId, randomUUID()].join(',') })
        .set('Authorization', bearer('c1'));

      expect(res.status).toBe(200);
      expect(res.body.map((p: { reservationId: string }) => p.reservationId).sort()).toEqual([a.reservationId, b.reservationId].sort());
      expect(res.body.find((p: { id: string }) => p.id === b.id)).toMatchObject({ status: 'SUCCEEDED', amountCents: 15000 });
    });
  });

  describe('POST /payments/:id/pay', () => {
    it('tok_approved: cobra, queda SUCCEEDED y deja payment.succeeded en el outbox', async () => {
      const p = await seed();

      const res = await pay(p.id, 'tok_approved');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: p.id, status: 'SUCCEEDED', provider: 'simulated' });
      expect(res.body.paidAt).toBeTruthy();
      expect(res.body.providerChargeId).toBeUndefined(); // no se filtran datos internos de la pasarela
      const [event] = await outboxOf('payment.succeeded', p.id);
      expect(event.payload.data).toEqual({ paymentId: p.id, reservationId: p.reservationId, amountCents: 15000 });
    });

    it('tok_declined: queda FAILED con el motivo y deja payment.failed', async () => {
      const p = await seed();

      const res = await pay(p.id, 'tok_declined');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
      expect((await outboxOf('payment.failed', p.id))[0].payload.data).toMatchObject({ reason: 'card_declined' });
      expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(0);
    });

    describe('idempotencia', () => {
      it('repetir el pedido con la misma Idempotency-Key devuelve la misma respuesta y cobra UNA vez', async () => {
        const p = await seed();
        const charge = jest.spyOn(gateway, 'createCharge');
        const key = randomUUID();

        const first = await pay(p.id, 'tok_approved', key);
        const second = await pay(p.id, 'tok_approved', key);

        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(first.headers['idempotent-replayed']).toBeUndefined();
        expect(charge).toHaveBeenCalledTimes(1);
        expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(1);
      });

      it('la misma clave con OTRO pedido (otro token) es un error del cliente: 422', async () => {
        const p = await seed();
        const key = randomUUID();
        await pay(p.id, 'tok_declined', key);

        const res = await pay(p.id, 'tok_approved', key);

        expect(res.status).toBe(422);
        expect(await statusOf(p.id)).toBe('FAILED');
      });

      it('un error del cliente también se repite igual con la misma clave (409 guardado)', async () => {
        const p = await seed({ status: PaymentStatus.SUCCEEDED });
        const key = randomUUID();

        const first = await pay(p.id, 'tok_approved', key);
        const second = await pay(p.id, 'tok_approved', key);

        expect(first.status).toBe(409);
        expect(second.status).toBe(409);
        expect(second.body.message).toBe(first.body.message);
      });

      it('10 pedidos simultáneos con la MISMA clave: todos reciben la misma respuesta y se cobra una sola vez', async () => {
        const p = await seed();
        const charge = jest.spyOn(gateway, 'createCharge');
        const key = randomUUID();

        const results = await Promise.all(Array.from({ length: 10 }, () => pay(p.id, 'tok_approved', key)));

        expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
        for (const r of results) expect(r.body).toEqual(results[0].body); // (jsonb no conserva el orden de las claves: se compara por contenido)
        expect(charge).toHaveBeenCalledTimes(1);
        expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(1);
      });

      it('10 pedidos simultáneos con claves DISTINTAS: exactamente uno cobra y el resto recibe 409', async () => {
        const p = await seed();
        const charge = jest.spyOn(gateway, 'createCharge');

        const results = await Promise.all(Array.from({ length: 10 }, () => pay(p.id, 'tok_approved')));

        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([200, ...Array(9).fill(409)]);
        expect(charge).toHaveBeenCalledTimes(1);
        expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(1);
      });

      it('la clave es por usuario: otro usuario con la misma cadena no recibe la respuesta ajena', async () => {
        const mine = await seed({ customerId: 'c1' });
        const theirs = await seed({ customerId: 'c2' });
        const key = randomUUID();

        expect((await pay(mine.id, 'tok_approved', key, 'c1')).status).toBe(200);
        const other = await pay(theirs.id, 'tok_approved', key, 'c2');

        expect(other.status).toBe(200);
        expect(other.body.id).toBe(theirs.id);
        expect(other.headers['idempotent-replayed']).toBeUndefined();
      });
    });

    describe('pasarela caída', () => {
      it('tok_error: responde 502, no cobra, el pago sigue PENDING y la MISMA clave se puede reintentar', async () => {
        const p = await seed();
        const key = randomUUID();

        const failed = await pay(p.id, 'tok_error', key);
        expect(failed.status).toBe(502);
        expect(await statusOf(p.id)).toBe('PENDING');
        expect(await outboxOf('payment.failed', p.id)).toHaveLength(0);

        // El 502 no se guardó: la clave quedó libre. (Con tok_error la pasarela real hubiera podido recuperarse.)
        const retry = await pay(p.id, 'tok_approved', key);
        expect(retry.status).toBe(200);
        expect(retry.body.status).toBe('SUCCEEDED');
      });
    });

    describe('webhooks (pasarela asíncrona)', () => {
      it('tok_slow: responde 202 PROCESSING y a los pocos ms el webhook real lo deja SUCCEEDED', async () => {
        const p = await seed();

        const res = await pay(p.id, 'tok_slow');
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('PROCESSING');

        await waitFor(async () => (await statusOf(p.id)) === 'SUCCEEDED');
        expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(1);
        expect((await getPayment(p.id)).body.status).toBe('SUCCEEDED');
      });

      it('tok_slow_declined: el webhook de rechazo deja FAILED y emite payment.failed', async () => {
        const p = await seed();
        await pay(p.id, 'tok_slow_declined');

        await waitFor(async () => (await statusOf(p.id)) === 'FAILED');
        expect((await outboxOf('payment.failed', p.id))[0].payload.data).toMatchObject({ reason: 'card_declined' });
      });

      it('tok_slow_duplicate: el webhook llega DOS veces y se aplica una sola', async () => {
        const p = await seed();
        await pay(p.id, 'tok_slow_duplicate');

        await waitFor(async () => (await statusOf(p.id)) === 'SUCCEEDED');
        await new Promise((r) => setTimeout(r, 300)); // da tiempo a que llegue el repetido
        expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(1);
        expect(await ds.getRepository(GatewayEvent).count()).toBe(1);
      });

      it('mientras está PROCESSING no se puede volver a cobrar (409)', async () => {
        const p = await seed();
        await pay(p.id, 'tok_slow');

        const again = await pay(p.id, 'tok_approved');

        expect(again.status).toBe(409);
      });

      describe('autenticidad', () => {
        const hook = (body: string, signature?: string) => {
          const req = request(app.getHttpServer()).post('/webhooks/gateway').set('Content-Type', 'application/json');
          if (signature) req.set(SIGNATURE_HEADER, signature);
          return req.send(body);
        };
        const processing = async () => seed({ status: PaymentStatus.PROCESSING, providerChargeId: 'ch_known', provider: 'simulated' });
        const event = (extra: object = {}) => JSON.stringify({ eventId: `evt_${randomUUID()}`, type: 'charge.succeeded', chargeId: 'ch_known', ...extra });

        it('un webhook bien firmado se aplica', async () => {
          const p = await processing();
          const body = event();

          const res = await hook(body, signWebhook(SECRET, body));

          expect(res.status).toBe(200);
          expect(res.body).toEqual({ received: true, result: 'applied' });
          expect(await statusOf(p.id)).toBe('SUCCEEDED');
        });

        it('sin firma → 401 y no cambia nada', async () => {
          const p = await processing();

          expect((await hook(event())).status).toBe(401);
          expect(await statusOf(p.id)).toBe('PROCESSING');
        });

        it('firmado con otro secreto → 401', async () => {
          const p = await processing();
          const body = event();

          expect((await hook(body, signWebhook('otro-secreto', body))).status).toBe(401);
          expect(await statusOf(p.id)).toBe('PROCESSING');
        });

        it('cuerpo alterado después de firmar (de rechazado a aprobado) → 401', async () => {
          const p = await processing();
          const original = event({ type: 'charge.failed' });
          const signature = signWebhook(SECRET, original);

          expect((await hook(original.replace('charge.failed', 'charge.succeeded'), signature)).status).toBe(401);
          expect(await statusOf(p.id)).toBe('PROCESSING');
        });

        it('firma vieja (repetición de un mensaje capturado) → 401', async () => {
          await processing();
          const body = event();

          expect((await hook(body, signWebhook(SECRET, body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
        });

        it('un cobro desconocido → 404 y NO queda registrado el evento (la pasarela puede reintentar)', async () => {
          const body = event({ chargeId: 'ch_nope', eventId: 'evt_retry' });

          expect((await hook(body, signWebhook(SECRET, body))).status).toBe(404);
          expect(await ds.getRepository(GatewayEvent).count()).toBe(0);

          // ...y cuando el cobro aparece, el mismo evento sí se aplica
          const p = await seed({ status: PaymentStatus.PROCESSING, providerChargeId: 'ch_nope', provider: 'simulated' });
          expect((await hook(body, signWebhook(SECRET, body))).body.result).toBe('applied');
          expect(await statusOf(p.id)).toBe('SUCCEEDED');
        });

        it('el MISMO evento enviado dos veces (mismo eventId) se aplica una vez; el repetido se reconoce como duplicado', async () => {
          const p = await processing();
          const body = event({ eventId: 'evt_same' });
          const signature = signWebhook(SECRET, body);

          const first = await hook(body, signature);
          const second = await hook(body, signature);

          expect(first.body.result).toBe('applied');
          expect(second.status).toBe(200);
          expect(second.body.result).toBe('duplicate');
          expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(1);
        });

        it('un webhook para un pago que ya se resolvió no lo pisa', async () => {
          const p = await seed({ status: PaymentStatus.FAILED, providerChargeId: 'ch_done', provider: 'simulated' });
          const body = event({ chargeId: 'ch_done' });

          const res = await hook(body, signWebhook(SECRET, body));

          expect(res.body.result).toBe('already_settled');
          expect(await statusOf(p.id)).toBe('FAILED');
          expect(await outboxOf('payment.succeeded', p.id)).toHaveLength(0);
        });

        it('un cuerpo con firma válida pero que no es JSON → 400', async () => {
          const body = 'no es json';

          expect((await hook(body, signWebhook(SECRET, body))).status).toBe(400);
        });
      });
    });

    describe('reglas de negocio', () => {
      it('un pago ajeno responde 404', async () => {
        const p = await seed({ customerId: 'c2' });

        expect((await pay(p.id, 'tok_approved')).status).toBe(404);
        expect(await statusOf(p.id)).toBe('PENDING');
      });

      it('un pago inexistente responde 404', async () => {
        expect((await pay(randomUUID(), 'tok_approved')).status).toBe(404);
      });

      it('vencido el plazo no se puede pagar (409) aunque el pago siga PENDING', async () => {
        const p = await seed({ expiresAt: new Date(Date.now() - 1000) });

        const res = await pay(p.id, 'tok_approved');

        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/plazo/);
      });

      it.each([PaymentStatus.EXPIRED, PaymentStatus.CANCELLED, PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.REFUNDED])('un pago %s no se puede cobrar (409)', async (status) => {
        const p = await seed({ status });

        expect((await pay(p.id, 'tok_approved')).status).toBe(409);
      });
    });
  });

  describe('eventos de la reserva', () => {
    const base = (p: Payment) => ({ reservationId: p.reservationId, customerId: p.customerId, restaurantId: p.restaurantId });
    const paid = async () => {
      const p = await seed();
      await pay(p.id, 'tok_approved');
      return p;
    };

    it('reservation.expired anula el pago pendiente', async () => {
      const p = await seed();

      send('reservation.expired', base(p));

      await waitFor(async () => (await statusOf(p.id)) === 'EXPIRED');
      expect((await pay(p.id, 'tok_approved')).status).toBe(409);
    });

    it('reservation.cancelled sobre un pago pendiente lo anula', async () => {
      const p = await seed();

      send('reservation.cancelled', { ...base(p), reason: 'CANCELLED_BY_CUSTOMER', refundable: false, depositCents: 15000 });

      await waitFor(async () => (await statusOf(p.id)) === 'CANCELLED');
    });

    it('cancelar con anticipación (refundable) devuelve la seña y emite payment.refunded', async () => {
      const p = await paid();
      const refund = jest.spyOn(gateway, 'refund');

      send('reservation.cancelled', { ...base(p), reason: 'CANCELLED_BY_CUSTOMER', refundable: true, depositCents: 15000 });

      await waitFor(async () => (await statusOf(p.id)) === 'REFUNDED');
      expect(refund).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 15000, idempotencyKey: `refund-${p.id}` }));
      expect((await outboxOf('payment.refunded', p.id))[0].payload.data).toMatchObject({ amountCents: 15000, reason: 'CANCELLED_BY_CUSTOMER' });
      expect((await getPayment(p.id)).body.refundedAt).toBeTruthy();
    });

    it('cancelar fuera de plazo (no refundable) conserva la seña: el pago sigue SUCCEEDED', async () => {
      const p = await paid();
      const refund = jest.spyOn(gateway, 'refund');

      send('reservation.cancelled', { ...base(p), reason: 'CANCELLED_BY_CUSTOMER', refundable: false, depositCents: 15000 });
      // Señal de que el evento anterior ya se procesó: un segundo evento distinto
      const marker = await seed();
      send('reservation.expired', base(marker));
      await waitFor(async () => (await statusOf(marker.id)) === 'EXPIRED');

      expect(await statusOf(p.id)).toBe('SUCCEEDED');
      expect(refund).not.toHaveBeenCalled();
    });

    it('una cancelación de una reserva SIN seña (depositCents 0) se ignora, sin errores ni reintentos', async () => {
      send('reservation.cancelled', { reservationId: randomUUID(), customerId: 'c1', restaurantId: '64b7f0c2a1b2c3d4e5f60718', reason: 'CANCELLED_BY_CUSTOMER', refundable: true, depositCents: 0 });
      const marker = await seed();
      send('reservation.expired', base(marker));
      await waitFor(async () => (await statusOf(marker.id)) === 'EXPIRED');

      expect(await channel.get(deadLetterQueueOf(consumer.queueName), { noAck: true })).toBe(false);
    });

    it('si la reserva se cancela mientras el cobro está PROCESSING, el pago no se toca (lo resuelve el webhook)', async () => {
      const p = await seed({ status: PaymentStatus.PROCESSING, providerChargeId: 'ch_x', provider: 'simulated' });

      send('reservation.cancelled', { ...base(p), reason: 'CANCELLED_BY_CUSTOMER', refundable: true, depositCents: 15000 });
      const marker = await seed();
      send('reservation.expired', base(marker));
      await waitFor(async () => (await statusOf(marker.id)) === 'EXPIRED');

      expect(await statusOf(p.id)).toBe('PROCESSING');
    });

    it('reservation.refund_requested (pago tardío) devuelve el dinero; repetido, devuelve una sola vez', async () => {
      const p = await paid();
      const refund = jest.spyOn(gateway, 'refund');
      const envelope = createEnvelope('reservation.refund_requested', { reservationId: p.reservationId, paymentId: p.id, reason: 'RESERVATION_EXPIRED' });

      sendEnvelope('reservation.refund_requested', envelope);
      sendEnvelope('reservation.refund_requested', envelope);
      send('reservation.refund_requested', { reservationId: p.reservationId, paymentId: p.id, reason: 'RESERVATION_EXPIRED' }); // otro mensaje, mismo pedido

      await waitFor(async () => (await statusOf(p.id)) === 'REFUNDED');
      await new Promise((r) => setTimeout(r, 900)); // más que todos los reintentos posibles (5 × 100 ms)
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await outboxOf('payment.refunded', p.id)).toHaveLength(1);
      // El pedido repetido es un no-op limpio: no se reintentó ni terminó en la DLQ
      expect(await channel.get(deadLetterQueueOf(consumer.queueName), { noAck: true })).toBe(false);
    });

    it('cancelación + pedido de devolución a la vez: se devuelve una sola vez (lock de la fila)', async () => {
      const p = await paid();
      const refund = jest.spyOn(gateway, 'refund');

      send('reservation.cancelled', { ...base(p), reason: 'CANCELLED_BY_OWNER', refundable: true, depositCents: 15000 });
      send('reservation.refund_requested', { reservationId: p.reservationId, paymentId: p.id, reason: 'RESERVATION_CANCELLED' });

      await waitFor(async () => (await statusOf(p.id)) === 'REFUNDED');
      await new Promise((r) => setTimeout(r, 300));
      expect(refund).toHaveBeenCalledTimes(1);
      expect(await outboxOf('payment.refunded', p.id)).toHaveLength(1);
    });

    it('si la pasarela falla al devolver, el evento se reintenta y no queda nada a medias', async () => {
      const p = await paid();
      const refund = jest
        .spyOn(gateway, 'refund')
        .mockRejectedValueOnce(new GatewayUnavailableError('pasarela caída'))
        .mockRejectedValueOnce(new GatewayUnavailableError('pasarela caída'));
      refund.mockImplementation(async () => ({ refundId: 're_ok' })); // desde el tercer intento funciona
      refund.mockRejectedValueOnce(new GatewayUnavailableError('pasarela caída'));

      send('reservation.cancelled', { ...base(p), reason: 'CANCELLED_BY_CUSTOMER', refundable: true, depositCents: 15000 });

      await waitFor(async () => (await statusOf(p.id)) === 'REFUNDED');
      expect(refund.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await outboxOf('payment.refunded', p.id)).toHaveLength(1);
    });

    it('un evento sobre una reserva cuyo pago todavía no existe se reintenta y se aplica cuando llega reservation.created (desorden)', async () => {
      const reservationId = randomUUID();
      send('reservation.expired', { reservationId, customerId: 'c1', restaurantId: '64b7f0c2a1b2c3d4e5f60718' }); // llega ANTES

      await new Promise((r) => setTimeout(r, 250)); // al menos un reintento fallido
      send('reservation.created', { reservationId, customerId: 'c1', restaurantId: '64b7f0c2a1b2c3d4e5f60718', amountCents: 15000, currency: 'ARS', expiresAt: new Date(Date.now() + 900_000).toISOString() });

      await waitFor(async () => (await ds.getRepository(Payment).findOneBy({ reservationId }))?.status === PaymentStatus.EXPIRED);
    });

    it('un pedido de devolución de un pago que no existe va a la DLQ', async () => {
      send('reservation.refund_requested', { reservationId: randomUUID(), paymentId: randomUUID(), reason: 'X' });

      const dead = await waitFor(async () => (await channel.get(deadLetterQueueOf(consumer.queueName), { noAck: true })) || undefined);
      expect(String(dead.properties.headers?.['x-error'])).toContain('no existe');
    });
  });
});
