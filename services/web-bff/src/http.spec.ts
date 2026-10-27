import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { JsonLogger } from './observability/json-logger';
import { FakeService, RecordedCall } from './test-utils/fake-service';

/**
 * Pruebas de punta a punta del BFF: la app Nest real, hablando por HTTP real con tres
 * "microservicios" falsos (servidores de Node). Verifican lo que importa de un BFF:
 * que reenvíe lo correcto, que agregue en paralelo y que sobreviva a fallas parciales.
 */
const RID = '64b7f0c2a1b2c3d4e5f60718';
const RID2 = '64b7f0c2a1b2c3d4e5f60719';
const RES_ID = '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10';

const ok = (body: unknown) => ({ body });
const fail = (status: number, message: string) => ({ status, body: { statusCode: status, error: 'Err', message } });

describe('web-bff (HTTP + servicios falsos)', () => {
  let app: INestApplication;
  let auth: FakeService;
  let restaurants: FakeService;
  let reservations: FakeService;
  let payments: FakeService;
  let notifications: FakeService;
  let jwt: JwtService;

  const token = (sub = 'user-1') => jwt.sign({ sub, email: `${sub}@example.com`, role: 'CUSTOMER' });
  const authz = (sub?: string) => `Bearer ${token(sub)}`;
  const server = () => request(app.getHttpServer());
  const query = (call: RecordedCall) => Object.fromEntries(new URL(call.path, 'http://x').searchParams);

  beforeAll(async () => {
    [auth, restaurants, reservations, payments, notifications] = await Promise.all([
      FakeService.start(),
      FakeService.start(),
      FakeService.start(),
      FakeService.start(),
      FakeService.start(),
    ]);
    Object.assign(process.env, {
      JWT_SECRET: 'bff-test-secret',
      AUTH_SERVICE_URL: auth.url,
      RESTAURANTS_SERVICE_URL: restaurants.url,
      RESERVATIONS_SERVICE_URL: reservations.url,
      PAYMENTS_SERVICE_URL: payments.url,
      NOTIFICATIONS_SERVICE_URL: notifications.url,
      PAYMENT_LOOKUP_ATTEMPTS: '3',
      PAYMENT_LOOKUP_DELAY_MS: '0',
      UPSTREAM_TIMEOUT_MS: '400',
      UPSTREAM_RETRY_DELAY_MS: '0',
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { AppModule } = await import('./app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0);
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([auth.stop(), restaurants.stop(), reservations.stop(), payments.stop(), notifications.stop()]);
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    for (const fake of [auth, restaurants, reservations, payments, notifications]) fake.reset(() => fail(404, 'ruta no definida en el test'));
  });

  describe('autenticación', () => {
    it('login reenvía a auth-service y devuelve su respuesta', async () => {
      auth.handler = () => ok({ accessToken: 'jwt', user: { id: '1' } });

      const res = await server().post('/auth/login').send({ email: 'ana@example.com', password: 'Password123' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accessToken: 'jwt', user: { id: '1' } });
      expect(auth.calls[0]).toMatchObject({ method: 'POST', path: '/auth/login', body: { email: 'ana@example.com', password: 'Password123' } });
    });

    it('register responde 201 y propaga un 409 de email repetido', async () => {
      auth.handler = () => ok({ accessToken: 'jwt' });
      const created = await server().post('/auth/register').send({ email: 'a@b.com', name: 'Ana', password: 'Password123' });
      expect(created.status).toBe(201);

      auth.handler = () => fail(409, 'El email ya está registrado');
      const dup = await server().post('/auth/register').send({ email: 'a@b.com', name: 'Ana', password: 'Password123' });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ message: 'El email ya está registrado', path: '/auth/register' });
    });

    it('credenciales inválidas: el 401 de auth llega tal cual', async () => {
      auth.handler = () => fail(401, 'Credenciales inválidas');

      const res = await server().post('/auth/login').send({ email: 'a@b.com', password: 'x' });

      expect(res.status).toBe(401);
    });

    it('valida el body ANTES de molestar a auth-service', async () => {
      const res = await server().post('/auth/register').send({ email: 'no-es-mail', name: 'A', password: '123', role: 'ADMIN' });

      expect(res.status).toBe(400);
      expect(auth.calls).toHaveLength(0);
    });

    it('/auth/me reenvía el token del usuario', async () => {
      auth.handler = () => ok({ id: 'user-1', email: 'user-1@example.com' });
      const bearer = authz();

      const res = await server().get('/auth/me').set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(auth.calls[0].headers.authorization).toBe(bearer);
    });
  });

  describe('seguridad', () => {
    it.each([
      ['GET', '/auth/me'],
      ['GET', '/me/overview'],
      ['GET', '/reservations/mine'],
      ['POST', '/reservations'],
      ['GET', `/reservations/${RES_ID}`],
      ['POST', `/reservations/${RES_ID}/cancel`],
    ])('%s %s sin token da 401 y no llega a ningún servicio', async (method, url) => {
      const res = await server()[method.toLowerCase() as 'get'](url);

      expect(res.status).toBe(401);
      expect([auth, restaurants, reservations].flatMap((f) => f.calls)).toHaveLength(0);
    });

    it('un token firmado con otro secreto da 401', async () => {
      const forged = new JwtService({ secret: 'otro' }).sign({ sub: 'x', email: 'x@x', role: 'CUSTOMER' });

      const res = await server().get('/reservations/mine').set('Authorization', `Bearer ${forged}`);

      expect(res.status).toBe(401);
      expect(reservations.calls).toHaveLength(0);
    });

    it('las rutas públicas no piden token', async () => {
      restaurants.handler = () => ok({ data: [], total: 0 });

      expect((await server().get('/restaurants')).status).toBe(200);
    });
  });

  describe('correlation id', () => {
    it('genera uno, lo devuelve y lo reenvía a los servicios', async () => {
      restaurants.handler = () => ok({ data: [] });

      const res = await server().get('/restaurants');
      const id = res.headers['x-correlation-id'];

      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(restaurants.calls[0].headers['x-correlation-id']).toBe(id);
    });

    it('respeta el que manda el cliente en toda la cadena', async () => {
      restaurants.handler = () => ok({ data: [] });

      const res = await server().get('/restaurants').set('x-correlation-id', 'front-abc-12345');

      expect(res.headers['x-correlation-id']).toBe('front-abc-12345');
      expect(restaurants.calls[0].headers['x-correlation-id']).toBe('front-abc-12345');
    });

    it('también está en las respuestas de error', async () => {
      const res = await server().get('/reservations/mine');

      expect(res.status).toBe(401);
      expect(res.headers['x-correlation-id']).toBeDefined();
    });
  });

  describe('GET /restaurants', () => {
    it('reenvía los filtros de búsqueda', async () => {
      restaurants.handler = () => ok({ data: [], total: 0 });

      await server().get('/restaurants?search=parri&cuisine=Parrilla&page=2&limit=5');

      expect(query(restaurants.calls[0])).toEqual({ page: '2', limit: '5', search: 'parri', cuisine: 'Parrilla' });
    });

    it('rechaza parámetros inválidos o desconocidos sin llamar al servicio', async () => {
      const res = await server().get('/restaurants?limit=1000&hack=1');

      expect(res.status).toBe(400);
      expect(restaurants.calls).toHaveLength(0);
    });
  });

  describe('GET /restaurants/:id/overview (agregación)', () => {
    const restaurantsRoutes = (call: RecordedCall) => {
      if (call.path === `/restaurants/${RID}`) return ok({ id: RID, name: 'La Parrilla' });
      if (call.path.startsWith(`/restaurants/${RID}/menu`)) return ok([{ category: 'Carnes', items: [] }]);
      return fail(404, 'no existe');
    };
    const availabilityOk = () => ok({ slots: [{ startsAt: '2026-10-16T23:00:00.000Z', availableTables: 2 }] });

    it('junta restaurante + carta + disponibilidad en una respuesta', async () => {
      restaurants.handler = restaurantsRoutes;
      reservations.handler = availabilityOk;

      const res = await server().get(`/restaurants/${RID}/overview?date=2026-10-16&partySize=4`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        restaurant: { id: RID, name: 'La Parrilla' },
        menu: [{ category: 'Carnes', items: [] }],
        availability: { slots: [{ startsAt: '2026-10-16T23:00:00.000Z', availableTables: 2 }] },
        warnings: [],
      });
      expect(reservations.calls[0].path).toBe(`/availability?restaurantId=${RID}&date=2026-10-16&partySize=4`);
    });

    it('sin date/partySize no consulta disponibilidad', async () => {
      restaurants.handler = restaurantsRoutes;

      const res = await server().get(`/restaurants/${RID}/overview`);

      expect(res.body.availability).toBeNull();
      expect(res.body.warnings).toEqual([]);
      expect(reservations.calls).toHaveLength(0);
    });

    it('las tres consultas salen EN PARALELO (no una detrás de otra)', async () => {
      restaurants.handler = (call) => ({ ...restaurantsRoutes(call), delayMs: 150 });
      reservations.handler = () => ({ ...availabilityOk(), delayMs: 150 });

      const started = Date.now();
      const res = await server().get(`/restaurants/${RID}/overview?date=2026-10-16&partySize=4`);

      expect(res.status).toBe(200);
      // En serie serían 450 ms (3 × 150); en paralelo ~150 ms
      expect(Date.now() - started).toBeLessThan(380);
    });

    it('si la carta falla, responde igual con el restaurante y avisa', async () => {
      restaurants.handler = (call) => (call.path.includes('/menu') ? fail(500, 'boom') : restaurantsRoutes(call));

      const res = await server().get(`/restaurants/${RID}/overview`);

      expect(res.status).toBe(200);
      expect(res.body.restaurant.name).toBe('La Parrilla');
      expect(res.body.menu).toBeNull();
      expect(res.body.warnings).toEqual([{ section: 'menu', message: expect.any(String) }]);
    });

    it('si reservations-service está caído, igual se ve el restaurante con su carta', async () => {
      restaurants.handler = restaurantsRoutes;
      reservations.handler = () => fail(500, 'caído');

      const res = await server().get(`/restaurants/${RID}/overview?date=2026-10-16&partySize=2`);

      expect(res.status).toBe(200);
      expect(res.body.menu).not.toBeNull();
      expect(res.body.availability).toBeNull();
      expect(res.body.warnings.map((w: { section: string }) => w.section)).toEqual(['availability']);
    });

    it('si el restaurante no existe, 404 (no tiene sentido responder el resto)', async () => {
      restaurants.handler = () => fail(404, 'Restaurante no encontrado');

      const res = await server().get(`/restaurants/${RID}/overview`);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Restaurante no encontrado');
    });

    it('si restaurants-service está caído, 502 (el restaurante es imprescindible)', async () => {
      restaurants.handler = () => fail(500, 'caído');

      expect((await server().get(`/restaurants/${RID}/overview`)).status).toBe(502);
    });

    it.each([
      ['date sin partySize', '?date=2026-10-16'],
      ['partySize sin date', '?partySize=3'],
    ])('%s da 400', async (_label, qs) => {
      expect((await server().get(`/restaurants/${RID}/overview${qs}`)).status).toBe(400);
      expect(restaurants.calls).toHaveLength(0);
    });

    it('un id mal formado da 400 sin llamar a nadie', async () => {
      expect((await server().get('/restaurants/abc/overview')).status).toBe(400);
      expect(restaurants.calls).toHaveLength(0);
    });
  });

  describe('reservas', () => {
    const body = { restaurantId: RID, partySize: 3, startsAt: '2026-10-16T21:00:00-03:00' };
    const reservation = (id: string, restaurantId: string, startsAt = '2026-10-16T21:00:00-03:00') => ({ id, restaurantId, startsAt, status: 'CONFIRMED' });
    const names = (call: RecordedCall) => {
      if (call.path === `/restaurants/${RID}`) return ok({ id: RID, name: 'La Parrilla', cuisine: 'x' });
      if (call.path === `/restaurants/${RID2}`) return ok({ id: RID2, name: 'Pasta Nostra' });
      return fail(404, 'no existe');
    };

    it('crear reserva reenvía el body y el token, y agrega el nombre del restaurante', async () => {
      reservations.handler = () => ({ status: 201, body: reservation(RES_ID, RID) });
      restaurants.handler = names;
      const bearer = authz('cust-7');

      const res = await server().post('/reservations').set('Authorization', bearer).send(body);

      expect(res.status).toBe(201);
      expect(res.body.restaurant).toEqual({ id: RID, name: 'La Parrilla' });
      expect(reservations.calls[0]).toMatchObject({ method: 'POST', path: '/reservations', body });
      expect(reservations.calls[0].headers.authorization).toBe(bearer);
    });

    it('un 409 (sin mesas) llega al cliente como 409 con el mensaje original', async () => {
      reservations.handler = () => fail(409, 'No hay mesas disponibles en ese horario.');

      const res = await server().post('/reservations').set('Authorization', authz()).send(body);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/No hay mesas/);
      expect(restaurants.calls).toHaveLength(0); // no se intenta enriquecer un error
    });

    it('una falla de reservations-service al crear NO se reintenta (no duplicar reservas)', async () => {
      reservations.handler = () => fail(500, 'boom');

      const res = await server().post('/reservations').set('Authorization', authz()).send(body);

      expect(res.status).toBe(502);
      expect(reservations.callsTo('/reservations')).toHaveLength(1);
    });

    it('body inválido o con campos de más: 400 sin llamar al servicio', async () => {
      const res = await server().post('/reservations').set('Authorization', authz()).send({ ...body, customerId: 'otro', partySize: 0 });

      expect(res.status).toBe(400);
      expect(reservations.calls).toHaveLength(0);
    });

    it('"mine" agrega el nombre del restaurante y consulta cada restaurante UNA vez', async () => {
      reservations.handler = () =>
        ok({ data: [reservation('a', RID), reservation('b', RID2), reservation('c', RID)], page: 1, limit: 10, total: 3, totalPages: 1 });
      restaurants.handler = names;

      const res = await server().get('/reservations/mine?limit=10').set('Authorization', authz());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, total: 3, totalPages: 1 });
      expect(res.body.data.map((r: { restaurant: { name: string } }) => r.restaurant.name)).toEqual(['La Parrilla', 'Pasta Nostra', 'La Parrilla']);
      expect(restaurants.calls).toHaveLength(2); // no 3
    });

    it('si no se puede obtener el nombre, la reserva igual se devuelve con restaurant: null', async () => {
      reservations.handler = () => ok({ data: [reservation('a', RID)], page: 1, limit: 10, total: 1, totalPages: 1 });
      restaurants.handler = () => fail(500, 'caído');

      const res = await server().get('/reservations/mine').set('Authorization', authz());

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ id: 'a', restaurantId: RID, restaurant: null });
    });

    it('una lista vacía no consulta restaurantes', async () => {
      reservations.handler = () => ok({ data: [], page: 1, limit: 10, total: 0, totalPages: 0 });

      await server().get('/reservations/mine').set('Authorization', authz());

      expect(restaurants.calls).toHaveLength(0);
    });

    it('reenvía el filtro y rechaza uno inválido', async () => {
      reservations.handler = () => ok({ data: [] });
      await server().get('/reservations/mine?status=CANCELLED&page=2').set('Authorization', authz());
      expect(query(reservations.calls[0])).toEqual({ page: '2', status: 'CANCELLED' });

      reservations.reset();
      const bad = await server().get('/reservations/mine?status=INVENTADO').set('Authorization', authz());
      expect(bad.status).toBe(400);
      expect(reservations.calls).toHaveLength(0);
    });

    it('ver y cancelar: pasan por el token del usuario y un 404 ajeno llega como 404', async () => {
      reservations.handler = (call) => (call.method === 'POST' ? ok({ ...reservation(RES_ID, RID), status: 'CANCELLED' }) : fail(404, 'Reserva no encontrada'));
      restaurants.handler = names;

      const cancelled = await server().post(`/reservations/${RES_ID}/cancel`).set('Authorization', authz());
      const view = await server().get(`/reservations/${RES_ID}`).set('Authorization', authz());

      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', restaurant: { name: 'La Parrilla' } });
      expect(view.status).toBe(404);
    });

    it('un id que no es UUID da 400', async () => {
      expect((await server().get('/reservations/123').set('Authorization', authz())).status).toBe(400);
      expect(reservations.calls).toHaveLength(0);
    });
  });

  describe('pagos de la seña', () => {
    const PAY_ID = '9b2c3d4e-1111-4c0e-9d3a-7a1f2b6c9d10';
    const KEY = 'b1f6d3a0-5c1e-4f6e-9a55-2f1d7c1e8a10';
    const payment = (status = 'PENDING') => ({ id: PAY_ID, reservationId: RES_ID, status, amountCents: 15000, currency: 'ARS', expiresAt: '2026-10-16T21:15:00.000Z', failureReason: null });
    const pay = (body: object = { token: 'tok_approved' }, key: string | null = KEY, id = RES_ID) => {
      const req = server().post(`/reservations/${id}/pay`).set('Authorization', authz('cust-7'));
      if (key !== null) req.set('Idempotency-Key', key);
      return req.send(body);
    };

    it('pagar: busca el pago de la reserva y cobra con la Idempotency-Key, reenviando el token del usuario', async () => {
      payments.handler = (call) =>
        call.method === 'GET' ? ok(payment()) : ok(payment('SUCCEEDED'));

      const res = await pay();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: PAY_ID, status: 'SUCCEEDED' });
      expect(payments.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /payments/by-reservation/${RES_ID}`, `POST /payments/${PAY_ID}/pay`]);
      const post = payments.calls[1];
      expect(post.body).toEqual({ token: 'tok_approved' });
      expect(post.headers['idempotency-key']).toBe(KEY);
      expect(post.headers.authorization).toBe(payments.calls[0].headers.authorization);
    });

    it('una respuesta repetida de payments (misma Idempotency-Key) se reconoce con el header Idempotent-Replayed', async () => {
      payments.handler = (call) => (call.method === 'GET' ? ok(payment()) : { status: 200, body: payment('SUCCEEDED'), headers: { 'Idempotent-Replayed': 'true' } });

      const res = await pay();

      expect(res.headers['idempotent-replayed']).toBe('true');
      expect((await pay()).status).toBe(200);
    });

    it('si la pasarela todavía procesa, el 202 llega como 202', async () => {
      payments.handler = (call) => (call.method === 'GET' ? ok(payment()) : { status: 202, body: payment('PROCESSING') });

      const res = await pay({ token: 'tok_slow' });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('PROCESSING');
    });

    it('el pago se crea de forma asíncrona: si todavía no existe, espera y reintenta antes de rendirse', async () => {
      let lookups = 0;
      payments.handler = (call) => {
        if (call.method === 'POST') return ok(payment('SUCCEEDED'));
        return ++lookups < 3 ? fail(404, 'Pago no encontrado') : ok(payment());
      };

      const res = await pay();

      expect(res.status).toBe(200);
      expect(lookups).toBe(3);
    });

    it('si el pago nunca aparece, responde 404 con un mensaje claro (y no cobra nada)', async () => {
      payments.handler = () => fail(404, 'Pago no encontrado');

      const res = await pay();

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/no tiene un pago pendiente/);
      expect(payments.calls.every((c) => c.method === 'GET')).toBe(true);
      expect(payments.calls).toHaveLength(3);
    });

    it('un 409 de payments (ya pagado, vencido...) llega tal cual', async () => {
      payments.handler = (call) => (call.method === 'GET' ? ok(payment()) : fail(409, 'Venció el plazo para pagar esta reserva'));

      const res = await pay();

      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Venció el plazo para pagar esta reserva');
    });

    it('si payments-service falla al cobrar, el POST NO se reintenta (no cobrar dos veces)', async () => {
      payments.handler = (call) => (call.method === 'GET' ? ok(payment()) : fail(500, 'caído'));

      const res = await pay();

      expect(res.status).toBe(502);
      expect(payments.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('valida Idempotency-Key y token ANTES de llamar a nadie', async () => {
      expect((await pay({ token: 'tok_approved' }, null)).status).toBe(400);
      expect((await pay({ token: 'tok_approved' }, 'corta')).status).toBe(400);
      expect((await pay({})).status).toBe(400);
      expect((await pay({ token: 'x', amountCents: 1 })).status).toBe(400);
      expect((await pay({ token: 'x' }, KEY, 'no-es-uuid')).status).toBe(400);
      expect(payments.calls).toHaveLength(0);
    });

    it('sin token de usuario responde 401', async () => {
      expect((await server().post(`/reservations/${RES_ID}/pay`).set('Idempotency-Key', KEY).send({ token: 'tok_approved' })).status).toBe(401);
    });

    it('GET /reservations/:id/payment devuelve el pago', async () => {
      payments.handler = () => ok(payment('FAILED'));

      const res = await server().get(`/reservations/${RES_ID}/payment`).set('Authorization', authz());

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FAILED');
    });

    describe('el estado del pago aparece en las reservas', () => {
      const withDeposit = (id: string, depositCents: number) => ({ id, restaurantId: RID, startsAt: '2026-10-16T21:00:00-03:00', status: 'PENDING_PAYMENT', depositCents });

      beforeEach(() => {
        restaurants.handler = () => ok({ id: RID, name: 'La Parrilla' });
      });

      it('"mine" suma el pago de las reservas con seña, y solo consulta las que tienen seña', async () => {
        reservations.handler = () => ok({ data: [withDeposit('11111111-1111-4111-8111-111111111111', 15000), withDeposit('22222222-2222-4222-8222-222222222222', 0)] });
        payments.handler = (call) => (call.path.endsWith('11111111-1111-4111-8111-111111111111') ? ok(payment()) : fail(404, 'x'));

        const res = await server().get('/reservations/mine').set('Authorization', authz());

        expect(res.body.data[0].payment).toMatchObject({ id: PAY_ID, status: 'PENDING' });
        expect(res.body.data[1].payment).toBeNull();
        expect(payments.calls).toHaveLength(1);
      });

      it('si payments-service está caído, la reserva sale igual con payment: null', async () => {
        reservations.handler = () => ok({ data: [withDeposit('11111111-1111-4111-8111-111111111111', 15000)] });
        payments.handler = () => fail(500, 'caído');

        const res = await server().get('/reservations/mine').set('Authorization', authz());

        expect(res.status).toBe(200);
        expect(res.body.data[0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', payment: null, restaurant: { name: 'La Parrilla' } });
      });

      it('crear una reserva con seña la devuelve PENDING_PAYMENT (el pago todavía puede no existir: payment null)', async () => {
        reservations.handler = () => ({ status: 201, body: withDeposit(RES_ID, 15000) });
        payments.handler = () => fail(404, 'Pago no encontrado');

        const res = await server().post('/reservations').set('Authorization', authz()).send({ restaurantId: RID, partySize: 3, startsAt: '2026-10-16T21:00:00-03:00' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: 'PENDING_PAYMENT', depositCents: 15000, payment: null });
      });
    });
  });

  describe('GET /me/overview', () => {
    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const mine = (...startsAt: string[]) =>
      ok({ data: startsAt.map((s, i) => ({ id: `r${i}`, restaurantId: RID, startsAt: s, status: 'CONFIRMED' })) });

    beforeEach(() => {
      auth.handler = () => ok({ id: 'user-1', name: 'Ana' });
      restaurants.handler = () => ok({ id: RID, name: 'La Parrilla' });
    });

    it('devuelve el perfil y las próximas reservas: futuras, de la más cercana a la más lejana', async () => {
      reservations.handler = () => mine(inHours(48), inHours(-5), inHours(2), inHours(24));

      const res = await server().get('/me/overview').set('Authorization', authz());

      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ id: 'user-1', name: 'Ana' });
      expect(res.body.upcomingReservations.map((r: { id: string }) => r.id)).toEqual(['r2', 'r3', 'r0']); // la pasada (r1) no está
      expect(res.body.upcomingReservations[0].restaurant.name).toBe('La Parrilla');
      expect(res.body.warnings).toEqual([]);
      expect(reservations.calls.map((c) => c.path).sort()).toEqual([
        '/reservations/mine?status=CONFIRMED&limit=50',
        '/reservations/mine?status=PENDING_PAYMENT&limit=10',
      ]);
    });

    it('muestra como máximo 5', async () => {
      reservations.handler = () => mine(...[1, 2, 3, 4, 5, 6, 7].map(inHours));

      const res = await server().get('/me/overview').set('Authorization', authz());

      expect(res.body.upcomingReservations).toHaveLength(5);
    });

    it('si reservations-service falla, igual devuelve el perfil con un aviso', async () => {
      reservations.handler = () => fail(500, 'caído');

      const res = await server().get('/me/overview').set('Authorization', authz());

      expect(res.status).toBe(200);
      expect(res.body.user.name).toBe('Ana');
      expect(res.body.upcomingReservations).toBeNull();
      expect(res.body.pendingPayments).toBeNull();
      expect(res.body.warnings).toEqual([
        { section: 'upcomingReservations', message: expect.any(String) },
        { section: 'pendingPayments', message: expect.any(String) },
      ]);
    });

    it('suma las reservas que esperan el pago (con su pago), aparte de las próximas', async () => {
      reservations.handler = (call) =>
        call.path.includes('PENDING_PAYMENT')
          ? ok({ data: [{ id: 'p1', restaurantId: RID, startsAt: inHours(30), status: 'PENDING_PAYMENT', depositCents: 15000 }] })
          : mine(inHours(2));
      payments.handler = () => ok({ id: 'pay-1', status: 'PENDING', amountCents: 15000 });

      const res = await server().get('/me/overview').set('Authorization', authz());

      expect(res.body.upcomingReservations.map((r: { id: string }) => r.id)).toEqual(['r0']);
      expect(res.body.pendingPayments).toEqual([
        expect.objectContaining({ id: 'p1', restaurant: { id: RID, name: 'La Parrilla' }, payment: expect.objectContaining({ id: 'pay-1' }) }),
      ]);
    });

    it('si falla solo la consulta de pendientes, lo demás se muestra y viene un aviso', async () => {
      reservations.handler = (call) => (call.path.includes('PENDING_PAYMENT') ? fail(500, 'caído') : mine(inHours(2)));

      const res = await server().get('/me/overview').set('Authorization', authz());

      expect(res.status).toBe(200);
      expect(res.body.upcomingReservations).toHaveLength(1);
      expect(res.body.pendingPayments).toBeNull();
      expect(res.body.warnings).toEqual([{ section: 'pendingPayments', message: expect.any(String) }]);
    });

    it('si auth-service falla, error (sin usuario no hay pantalla)', async () => {
      auth.handler = () => fail(500, 'caído');
      reservations.handler = () => mine();

      expect((await server().get('/me/overview').set('Authorization', authz())).status).toBe(502);
    });

    it('si auth-service responde 401 (usuario borrado), llega el 401', async () => {
      auth.handler = () => fail(401, 'Usuario inexistente');
      reservations.handler = () => mine();

      expect((await server().get('/me/overview').set('Authorization', authz())).status).toBe(401);
    });
  });

  describe('panel del dueño (/owner)', () => {
    const asOwner = () => `Bearer ${jwt.sign({ sub: 'owner-1', email: 'o@example.com', role: 'RESTAURANT_OWNER' })}`;

    it('sin token responde 401 y no llama a ningún servicio', async () => {
      await server().get('/owner/restaurants').expect(401);
      expect(restaurants.calls).toHaveLength(0);
    });

    it('lista mis restaurantes reenviando el token', async () => {
      restaurants.handler = () => ok([{ id: RID, name: 'La Parrilla' }]);
      const bearer = asOwner(); // uno solo: firmar otro más tarde puede cambiar el iat (segundos) y no coincidir

      const res = await server().get('/owner/restaurants').set('Authorization', bearer).expect(200);

      expect(res.body).toEqual([{ id: RID, name: 'La Parrilla' }]);
      expect(restaurants.calls[0]).toMatchObject({ method: 'GET', path: '/restaurants/mine' });
      expect(restaurants.calls[0].headers.authorization).toBe(bearer);
    });

    it('un cliente recibe el 403 de restaurants-service', async () => {
      restaurants.handler = () => fail(403, 'Requiere rol RESTAURANT_OWNER');

      const res = await server().get('/owner/restaurants').set('Authorization', authz()).expect(403);

      expect(res.body.message).toMatch(/RESTAURANT_OWNER/);
    });

    it('lista las reservas del local con sus filtros', async () => {
      reservations.handler = () => ok({ data: [{ id: RES_ID, customerName: 'Ana Pérez' }], page: 1, limit: 20, total: 1, totalPages: 1 });

      const res = await server()
        .get(`/owner/restaurants/${RID}/reservations?date=2026-10-16&status=CONFIRMED&page=2&limit=20`)
        .set('Authorization', asOwner())
        .expect(200);

      expect(res.body.data[0].customerName).toBe('Ana Pérez');
      expect(reservations.calls[0].path.startsWith(`/reservations/restaurant/${RID}?`)).toBe(true);
      expect(query(reservations.calls[0])).toEqual({ date: '2026-10-16', status: 'CONFIRMED', page: '2', limit: '20' });
    });

    it('el resumen del día se pide con la fecha y devuelve los conteos del servicio', async () => {
      const body = { date: '2026-10-16', total: 4, byStatus: { CONFIRMED: 3, NO_SHOW: 1 } };
      reservations.handler = () => ok(body);

      const res = await server().get(`/owner/restaurants/${RID}/summary?date=2026-10-16`).set('Authorization', asOwner()).expect(200);

      expect(res.body).toEqual(body);
      expect(reservations.calls[0].path).toBe(`/reservations/restaurant/${RID}/summary?date=2026-10-16`);
    });

    it('el resumen exige fecha válida y sesión, y propaga el 404 de un dueño ajeno', async () => {
      await server().get(`/owner/restaurants/${RID}/summary`).set('Authorization', asOwner()).expect(400);
      await server().get(`/owner/restaurants/${RID}/summary?date=16-10-2026`).set('Authorization', asOwner()).expect(400);
      await server().get(`/owner/restaurants/${RID}/summary?date=2026-10-16`).expect(401);
      expect(reservations.calls).toHaveLength(0);

      reservations.handler = () => fail(404, 'Restaurante no encontrado');
      await server().get(`/owner/restaurants/${RID}/summary?date=2026-10-16`).set('Authorization', asOwner()).expect(404);
    });

    it('rechaza ids y filtros inválidos sin llamar al servicio', async () => {
      const bad = (url: string) => server().get(url).set('Authorization', asOwner()).expect(400);
      await bad('/owner/restaurants/no-es-id/reservations');
      await bad(`/owner/restaurants/${RID}/reservations?date=16-10-2026`);
      await bad(`/owner/restaurants/${RID}/reservations?status=INVENTADO`);
      expect(reservations.calls).toHaveLength(0);
    });

    it('un dueño ajeno recibe el 403 de reservations-service', async () => {
      reservations.handler = () => fail(403, 'No sos el dueño de este restaurante');
      await server().get(`/owner/restaurants/${RID}/reservations`).set('Authorization', asOwner()).expect(403);
    });

    it('marca una reserva como NO_SHOW', async () => {
      reservations.handler = () => ok({ id: RES_ID, status: 'NO_SHOW' });

      const res = await server().patch(`/owner/reservations/${RES_ID}/status`).set('Authorization', asOwner()).send({ status: 'NO_SHOW' }).expect(200);

      expect(res.body.status).toBe('NO_SHOW');
      expect(reservations.calls[0]).toMatchObject({ method: 'PATCH', path: `/reservations/${RES_ID}/status`, body: { status: 'NO_SHOW' } });
    });

    it('solo acepta COMPLETED o NO_SHOW (CANCELLED tiene su propio endpoint)', async () => {
      await server().patch(`/owner/reservations/${RES_ID}/status`).set('Authorization', asOwner()).send({ status: 'CANCELLED' }).expect(400);
      expect(reservations.calls).toHaveLength(0);
    });

    it('propaga el 400 si la reserva todavía no empezó', async () => {
      reservations.handler = () => fail(400, 'La reserva todavía no empezó');
      const res = await server().patch(`/owner/reservations/${RES_ID}/status`).set('Authorization', asOwner()).send({ status: 'COMPLETED' }).expect(400);
      expect(res.body.message).toMatch(/todavía/);
    });
  });

  describe('gestión de restaurantes del dueño', () => {
    const asOwner = () => `Bearer ${jwt.sign({ sub: 'owner-1', email: 'o@example.com', role: 'RESTAURANT_OWNER' })}`;
    const valid = {
      name: 'La Parrilla',
      cuisine: 'Parrilla',
      address: 'Av. Mitre 1234',
      openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
      tables: [{ number: 1, capacity: 4 }],
    };

    it('crea un restaurante reenviando el cuerpo y el token', async () => {
      restaurants.handler = () => ({ status: 201, body: { id: RID, ...valid } });
      const bearer = asOwner();

      const res = await server().post('/owner/restaurants').set('Authorization', bearer).send(valid).expect(201);

      expect(res.body.id).toBe(RID);
      expect(restaurants.calls[0]).toMatchObject({ method: 'POST', path: '/restaurants', body: valid });
      expect(restaurants.calls[0].headers.authorization).toBe(bearer);
    });

    it('rechaza sin llamar al servicio: sin mesas, hora inválida o campos de más', async () => {
      const post = (body: object) => server().post('/owner/restaurants').set('Authorization', asOwner()).send(body).expect(400);
      await post({ ...valid, tables: [] });
      await post({ ...valid, openingHours: [{ dayOfWeek: 5, opens: '25:00', closes: '01:00' }] });
      await post({ ...valid, ownerId: 'otro' }); // el dueño sale del token, nunca del cuerpo
      expect(restaurants.calls).toHaveLength(0);
    });

    it('sin token responde 401', async () => {
      await server().post('/owner/restaurants').send(valid).expect(401);
    });

    it('un cliente recibe el 403 de restaurants-service', async () => {
      restaurants.handler = () => fail(403, 'Requiere rol RESTAURANT_OWNER');
      await server().post('/owner/restaurants').set('Authorization', authz()).send(valid).expect(403);
    });

    it('modifica solo los campos enviados', async () => {
      restaurants.handler = () => ok({ id: RID, ...valid, name: 'Nuevo' });

      await server().patch(`/owner/restaurants/${RID}`).set('Authorization', asOwner()).send({ name: 'Nuevo' }).expect(200);

      expect(restaurants.calls[0]).toMatchObject({ method: 'PATCH', path: `/restaurants/${RID}`, body: { name: 'Nuevo' } });
    });

    it('propaga el 400 de una regla de negocio (mesas repetidas)', async () => {
      restaurants.handler = () => fail(400, 'Hay números de mesa repetidos');
      const res = await server().patch(`/owner/restaurants/${RID}`).set('Authorization', asOwner()).send({ tables: [{ number: 1, capacity: 2 }, { number: 1, capacity: 4 }] }).expect(400);
      expect(res.body.message).toMatch(/repetidos/);
    });

    it('un dueño ajeno recibe el 403 al modificar o borrar', async () => {
      restaurants.handler = () => fail(403, 'No sos el dueño de este restaurante');
      await server().patch(`/owner/restaurants/${RID}`).set('Authorization', asOwner()).send({ name: 'Otro nombre' }).expect(403);
      await server().delete(`/owner/restaurants/${RID}`).set('Authorization', asOwner()).expect(403);
    });

    it('borra con 204 y sin cuerpo', async () => {
      restaurants.handler = () => ({ status: 204 });

      const res = await server().delete(`/owner/restaurants/${RID}`).set('Authorization', asOwner()).expect(204);

      expect(res.text).toBe('');
      expect(restaurants.calls[0]).toMatchObject({ method: 'DELETE', path: `/restaurants/${RID}` });
    });

    it('rechaza un id con formato inválido', async () => {
      await server().delete('/owner/restaurants/no-es-id').set('Authorization', asOwner()).expect(400);
      expect(restaurants.calls).toHaveLength(0);
    });
  });

  describe('carta del dueño', () => {
    const asOwner = () => `Bearer ${jwt.sign({ sub: 'owner-1', email: 'o@example.com', role: 'RESTAURANT_OWNER' })}`;
    const ITEM = '64b7f0c2a1b2c3d4e5f60999';
    const dish = { category: 'Postres', name: 'Flan casero', priceCents: 450000, allergens: ['MILK', 'EGGS'], variants: [{ name: 'Con crema', priceDeltaCents: 50000 }] };

    it('lista la carta pidiendo también los platos no disponibles', async () => {
      restaurants.handler = () => ok([{ category: 'Postres', items: [{ id: ITEM, name: 'Flan', available: false }] }]);

      const res = await server().get(`/owner/restaurants/${RID}/menu`).set('Authorization', asOwner()).expect(200);

      expect(res.body[0].items[0].available).toBe(false);
      expect(restaurants.calls[0].path).toBe(`/restaurants/${RID}/menu?includeUnavailable=true`);
    });

    it('agrega un plato reenviando el cuerpo y el token', async () => {
      restaurants.handler = () => ({ status: 201, body: { id: ITEM, ...dish } });
      const bearer = asOwner();

      await server().post(`/owner/restaurants/${RID}/menu-items`).set('Authorization', bearer).send(dish).expect(201);

      expect(restaurants.calls[0]).toMatchObject({ method: 'POST', path: `/restaurants/${RID}/menu-items`, body: dish });
      expect(restaurants.calls[0].headers.authorization).toBe(bearer);
    });

    it('rechaza sin llamar al servicio: alérgeno inventado, precio decimal o repetidos', async () => {
      const post = (body: object) => server().post(`/owner/restaurants/${RID}/menu-items`).set('Authorization', asOwner()).send(body).expect(400);
      await post({ ...dish, allergens: ['LACTOSE'] });
      await post({ ...dish, priceCents: 4500.5 });
      await post({ ...dish, allergens: ['MILK', 'MILK'] });
      await post({ ...dish, priceCents: -1 });
      expect(restaurants.calls).toHaveLength(0);
    });

    it('pausar un plato es un PATCH con available: false', async () => {
      restaurants.handler = () => ok({ id: ITEM, available: false });

      await server().patch(`/owner/restaurants/${RID}/menu-items/${ITEM}`).set('Authorization', asOwner()).send({ available: false }).expect(200);

      expect(restaurants.calls[0]).toMatchObject({ method: 'PATCH', path: `/restaurants/${RID}/menu-items/${ITEM}`, body: { available: false } });
    });

    it('un dueño ajeno recibe el 403 del servicio', async () => {
      restaurants.handler = () => fail(403, 'No sos el dueño de este restaurante');
      await server().post(`/owner/restaurants/${RID}/menu-items`).set('Authorization', asOwner()).send(dish).expect(403);
      await server().delete(`/owner/restaurants/${RID}/menu-items/${ITEM}`).set('Authorization', asOwner()).expect(403);
    });

    it('quita un plato con 204', async () => {
      restaurants.handler = () => ({ status: 204 });
      const res = await server().delete(`/owner/restaurants/${RID}/menu-items/${ITEM}`).set('Authorization', asOwner()).expect(204);
      expect(res.text).toBe('');
      expect(restaurants.calls[0]).toMatchObject({ method: 'DELETE', path: `/restaurants/${RID}/menu-items/${ITEM}` });
    });

    it('valida los ids y exige sesión', async () => {
      await server().get('/owner/restaurants/no-es-id/menu').set('Authorization', asOwner()).expect(400);
      await server().delete(`/owner/restaurants/${RID}/menu-items/no-es-id`).set('Authorization', asOwner()).expect(400);
      await server().get(`/owner/restaurants/${RID}/menu`).expect(401);
      expect(restaurants.calls).toHaveLength(0);
    });
  });

  describe('notificaciones (/notifications)', () => {
    const NID = '64b7f0c2a1b2c3d4e5f60aaa';
    const inbox = { data: [{ id: NID, title: 'Reserva confirmada', read: false }], page: 1, limit: 20, total: 1, totalPages: 1, unreadCount: 1 };

    it('lista reenviando el token y la query ya convertida (page, limit, unread)', async () => {
      notifications.handler = () => ok(inbox);
      const bearer = authz('user-9');

      const res = await server().get('/notifications?page=2&limit=5&unread=true').set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(inbox);
      expect(notifications.calls[0].path.split('?')[0]).toBe('/notifications');
      expect(query(notifications.calls[0])).toEqual({ page: '2', limit: '5', unread: 'true' });
      expect(notifications.calls[0].headers.authorization).toBe(bearer);
    });

    it('sin token es 401 y no molesta a notifications-service', async () => {
      const res = await server().get('/notifications');
      expect(res.status).toBe(401);
      expect(notifications.calls).toHaveLength(0);
    });

    it.each(['page=0', 'limit=51', 'unread=quizas', 'userId=otro'])('valida la query ANTES de reenviar (%s → 400)', async (qs) => {
      const res = await server().get(`/notifications?${qs}`).set('Authorization', authz());
      expect(res.status).toBe(400);
      expect(notifications.calls).toHaveLength(0);
    });

    it('el contador de la campanita se reenvía tal cual', async () => {
      notifications.handler = () => ok({ count: 3 });
      const res = await server().get('/notifications/unread-count').set('Authorization', authz());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 3 });
      expect(notifications.calls[0]).toMatchObject({ method: 'GET', path: '/notifications/unread-count' });
    });

    it('marcar todas como leídas es un POST que responde 200', async () => {
      notifications.handler = () => ok({ updated: 2 });
      const res = await server().post('/notifications/read-all').set('Authorization', authz());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2 });
      expect(notifications.calls[0]).toMatchObject({ method: 'POST', path: '/notifications/read-all' });
    });

    it('marcar una como leída reenvía el PATCH con su id', async () => {
      notifications.handler = () => ok({ id: NID, read: true });
      const res = await server().patch(`/notifications/${NID}/read`).set('Authorization', authz());
      expect(res.status).toBe(200);
      expect(notifications.calls[0]).toMatchObject({ method: 'PATCH', path: `/notifications/${NID}/read` });
    });

    it('un id mal formado es 400 sin llegar al servicio', async () => {
      const res = await server().patch('/notifications/no-es-un-id/read').set('Authorization', authz());
      expect(res.status).toBe(400);
      expect(notifications.calls).toHaveLength(0);
    });

    it('el 404 de una notificación ajena o inexistente llega igual al cliente', async () => {
      notifications.handler = () => fail(404, 'Notificación no encontrada');
      const res = await server().patch(`/notifications/${NID}/read`).set('Authorization', authz());
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: 'Notificación no encontrada' });
    });

    it('si notifications-service está caído, responde 502 y NO afecta a las reservas', async () => {
      notifications.handler = () => fail(500, 'caído');
      expect((await server().get('/notifications/unread-count').set('Authorization', authz())).status).toBe(502);

      reservations.handler = () => ok({ data: [], page: 1, limit: 10, total: 0, totalPages: 0 });
      expect((await server().get('/reservations/mine').set('Authorization', authz())).status).toBe(200);
    });
  });

  describe('trazabilidad de logs', () => {
    type Line = Record<string, unknown>;
    let lines: Line[];

    beforeEach(() => {
      jest.restoreAllMocks(); // el resto del archivo silencia warn/error; acá queremos verlos
      lines = [];
      Logger.overrideLogger(new JsonLogger({ service: 'web-bff', level: 'debug', write: (l) => lines.push(JSON.parse(l)) }));
    });
    afterEach(() => {
      Logger.overrideLogger(false);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    const of = (id: string) => lines.filter((l) => l.correlationId === id);

    it('TODOS los logs de una request comparten su correlationId: el de entrada, las llamadas a otros servicios y el cierre', async () => {
      restaurants.handler = (call) => (call.path.includes('/menu') ? ok([]) : ok({ id: RID, name: 'La Parrilla' }));
      reservations.handler = () => ok({ slots: [] });

      const res = await server().get(`/restaurants/${RID}/overview?date=2026-10-16&partySize=4`).set('x-correlation-id', 'traza-e2e-0001');

      expect(res.status).toBe(200);
      const mine = of('traza-e2e-0001');
      const messages = mine.map((l) => l.message);
      expect(messages.filter((m) => m === 'upstream call')).toHaveLength(3); // restaurante, carta, disponibilidad
      expect(messages).toContain('request completed');
      expect(mine.every((l) => l.service === 'web-bff')).toBe(true);
      // y ningún log de esta request quedó sin id
      expect(lines.filter((l) => !l.correlationId)).toEqual([]);
    });

    it('cada llamada a otro servicio registra a quién llamó, el status y cuánto tardó', async () => {
      restaurants.handler = () => ({ ...ok({ id: RID, name: 'x' }), delayMs: 40 });

      await server().get(`/restaurants/${RID}/overview`).set('x-correlation-id', 'traza-e2e-0002');

      const call = of('traza-e2e-0002').find((l) => l.message === 'upstream call' && l.path === `/restaurants/${RID}`)!;
      expect(call).toMatchObject({ upstream: 'restaurants', method: 'GET', status: 200 });
      expect(call.durationMs as number).toBeGreaterThanOrEqual(35);
    });

    it('el mismo id llega a los servicios en el header: así sus logs se pueden cruzar con los del BFF', async () => {
      restaurants.handler = () => ok({ data: [] });

      await server().get('/restaurants').set('x-correlation-id', 'traza-e2e-0003');

      expect(restaurants.calls[0].headers['x-correlation-id']).toBe('traza-e2e-0003');
    });

    it('un POST con body también conserva el id (el contexto sobrevive al parseo del body)', async () => {
      auth.handler = () => ok({ accessToken: 'jwt' });

      await server().post('/auth/login').set('x-correlation-id', 'traza-e2e-0004').send({ email: 'a@b.com', password: 'Password123' });

      expect(of('traza-e2e-0004').map((l) => l.message)).toEqual(expect.arrayContaining(['upstream call', 'request completed']));
      expect(auth.calls[0].headers['x-correlation-id']).toBe('traza-e2e-0004');
    });

    it('requests simultáneas no mezclan sus ids', async () => {
      restaurants.handler = (call) => ({ ...ok({ data: [], path: call.path }), delayMs: 20 });
      const ids = Array.from({ length: 8 }, (_, i) => `traza-conc-${i}000`);

      await Promise.all(ids.map((id) => server().get('/restaurants').set('x-correlation-id', id)));

      for (const id of ids) {
        const mine = of(id);
        expect(mine.map((l) => l.message).sort()).toEqual(['request completed', 'upstream call']);
      }
      // y cada llamada saliente llevó el id de su request, no el de otra
      expect(restaurants.calls.map((c) => c.headers['x-correlation-id']).sort()).toEqual([...ids].sort());
    });

    it('el userId aparece en los logs de las requests autenticadas', async () => {
      auth.handler = () => ok({ id: 'user-77' });

      await server().get('/auth/me').set('Authorization', authz('user-77')).set('x-correlation-id', 'traza-e2e-0005');

      expect(of('traza-e2e-0005').every((l) => l.userId === 'user-77')).toBe(true);
    });

    it('los errores también quedan trazados, con el nivel que corresponde', async () => {
      restaurants.handler = () => fail(500, 'boom');

      const res = await server().get(`/restaurants/${RID}/overview`).set('x-correlation-id', 'traza-e2e-0006');

      expect(res.status).toBe(502);
      const mine = of('traza-e2e-0006');
      expect(mine.find((l) => l.message === 'request completed')).toMatchObject({ level: 'error', status: 502 });
      expect(mine.filter((l) => l.message === 'upstream call' && l.level === 'warn').length).toBeGreaterThan(0);
    });

    it('los chequeos de salud no ensucian los logs normales (quedan en debug)', async () => {
      for (const fake of [auth, restaurants, reservations, payments, notifications]) fake.handler = () => ok({ status: 'ok' });

      await server().get('/health').set('x-correlation-id', 'traza-e2e-0007');

      const mine = of('traza-e2e-0007');
      expect(mine).toHaveLength(6); // la request de entrada + las 5 llamadas a los servicios
      expect(mine.every((l) => l.level === 'debug')).toBe(true);
    });

    it('un token o una contraseña jamás aparece en los logs', async () => {
      auth.handler = () => ok({ accessToken: 'ACCESS-TOKEN-SECRETO' });
      const bearer = authz('user-1');

      await server().post('/auth/login?debug=1').send({ email: 'a@b.com', password: 'ContraseñaSecreta123' });
      await server().get('/auth/me').set('Authorization', bearer);

      const everything = JSON.stringify(lines);
      expect(everything).not.toContain('ContraseñaSecreta123');
      expect(everything).not.toContain('ACCESS-TOKEN-SECRETO');
      expect(everything).not.toContain(bearer.replace('Bearer ', ''));
      expect(everything).not.toContain('debug=1');
    });
  });

  describe('GET /health', () => {
    it('ok si todos los servicios responden', async () => {
      for (const fake of [auth, restaurants, reservations, payments, notifications]) fake.handler = () => ok({ status: 'ok' });

      const res = await server().get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ok',
        service: 'web-bff',
        upstreams: { auth: 'up', restaurants: 'up', reservations: 'up', payments: 'up', notifications: 'up' },
      });
    });

    it('degraded (pero 200) si alguno está caído', async () => {
      auth.handler = () => ok({});
      restaurants.handler = () => ok({});
      payments.handler = () => ok({});
      notifications.handler = () => ok({});
      reservations.handler = () => fail(500, 'caído');

      const res = await server().get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'degraded', upstreams: { reservations: 'down', auth: 'up' } });
    });
  });

  describe('errores inesperados y Swagger', () => {
    it('una ruta inexistente usa el formato de error común', async () => {
      const res = await server().get('/nada');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, path: '/nada', timestamp: expect.any(String) });
    });

    it('documenta todas las rutas', () => {
      const doc = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());

      expect(Object.keys(doc.paths).sort()).toEqual(
        [
          '/auth/login',
          '/auth/me',
          '/auth/register',
          '/health',
          '/me/overview',
          '/notifications',
          '/notifications/read-all',
          '/notifications/unread-count',
          '/notifications/{id}/read',
          '/owner/reservations/{id}/status',
          '/owner/restaurants',
          '/owner/restaurants/{id}',
          '/owner/restaurants/{restaurantId}/menu',
          '/owner/restaurants/{restaurantId}/menu-items',
          '/owner/restaurants/{restaurantId}/menu-items/{itemId}',
          '/owner/restaurants/{id}/reservations',
          '/owner/restaurants/{id}/summary',
          '/reservations',
          '/reservations/mine',
          '/reservations/{id}',
          '/reservations/{id}/cancel',
          '/reservations/{id}/pay',
          '/reservations/{id}/payment',
          '/restaurants',
          '/restaurants/{id}/overview',
        ].sort(),
      );
    });
  });
});
