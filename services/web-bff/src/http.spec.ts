import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
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
  let jwt: JwtService;

  const token = (sub = 'user-1') => jwt.sign({ sub, email: `${sub}@example.com`, role: 'CUSTOMER' });
  const authz = (sub?: string) => `Bearer ${token(sub)}`;
  const server = () => request(app.getHttpServer());
  const query = (call: RecordedCall) => Object.fromEntries(new URL(call.path, 'http://x').searchParams);

  beforeAll(async () => {
    [auth, restaurants, reservations] = await Promise.all([FakeService.start(), FakeService.start(), FakeService.start()]);
    Object.assign(process.env, {
      JWT_SECRET: 'bff-test-secret',
      AUTH_SERVICE_URL: auth.url,
      RESTAURANTS_SERVICE_URL: restaurants.url,
      RESERVATIONS_SERVICE_URL: reservations.url,
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
    await Promise.all([auth.stop(), restaurants.stop(), reservations.stop()]);
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    for (const fake of [auth, restaurants, reservations]) fake.reset(() => fail(404, 'ruta no definida en el test'));
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
      expect(reservations.calls[0].path).toBe('/reservations/mine?status=CONFIRMED&limit=50');
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
      expect(res.body.warnings).toEqual([{ section: 'upcomingReservations', message: expect.any(String) }]);
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

  describe('GET /health', () => {
    it('ok si todos los servicios responden', async () => {
      for (const fake of [auth, restaurants, reservations]) fake.handler = () => ok({ status: 'ok' });

      const res = await server().get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', service: 'web-bff', upstreams: { auth: 'up', restaurants: 'up', reservations: 'up' } });
    });

    it('degraded (pero 200) si alguno está caído', async () => {
      auth.handler = () => ok({});
      restaurants.handler = () => ok({});
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
          '/reservations',
          '/reservations/mine',
          '/reservations/{id}',
          '/reservations/{id}/cancel',
          '/restaurants',
          '/restaurants/{id}/overview',
        ].sort(),
      );
    });
  });
});
