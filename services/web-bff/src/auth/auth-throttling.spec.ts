import { INestApplication, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../app.setup';
import { FakeService } from '../test-utils/fake-service';
import { REGISTER_LIMIT } from './auth-throttling';

/**
 * Límites de login y registro, con la app real y un auth-service falso. Cada test usa su propia IP
 * (X-Forwarded-For con trust proxy, como detrás de nginx), así los contadores no se mezclan entre tests.
 */
describe('límites de login y registro', () => {
  let app: INestApplication;
  let auth: FakeService;
  let others: FakeService[];

  const login = (ip: string, email: string) =>
    request(app.getHttpServer()).post('/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'Password123' });
  const register = (ip: string, n: number) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', ip)
      .send({ email: `u${n}@example.com`, name: 'Ana', password: 'Password123' });

  /** Manda los pedidos de a uno (en orden) y devuelve los códigos de respuesta. */
  const statuses = async (requests: Array<() => request.Test>) => {
    const result: number[] = [];
    for (const send of requests) result.push((await send()).status);
    return result;
  };
  const times = <T>(n: number, fn: (i: number) => T) => Array.from({ length: n }, (_, i) => fn(i));

  beforeAll(async () => {
    [auth, ...others] = await Promise.all(times(5, () => FakeService.start()));
    Object.assign(process.env, {
      JWT_SECRET: 'bff-test-secret',
      AUTH_SERVICE_URL: auth.url,
      RESTAURANTS_SERVICE_URL: others[0].url,
      RESERVATIONS_SERVICE_URL: others[1].url,
      PAYMENTS_SERVICE_URL: others[2].url,
      NOTIFICATIONS_SERVICE_URL: others[3].url,
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    (app as NestExpressApplication).set('trust proxy', 1);
    configureApp(app);
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([auth, ...others].map((fake) => fake.stop()));
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    auth.reset(() => ({ status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Credenciales inválidas' } }));
  });

  it('el intento 11 con el mismo email desde la misma IP da 429 y ni llega a auth-service', async () => {
    const codes = await statuses(times(11, () => () => login('10.0.0.1', 'ana@example.com')));

    expect(codes.slice(0, 10)).toEqual(times(10, () => 401));
    expect(codes[10]).toBe(429);
    expect(auth.calls).toHaveLength(10);
  });

  it('el 429 tiene el formato de error de siempre, en castellano y con Retry-After', async () => {
    await statuses(times(10, () => () => login('10.0.0.2', 'ana@example.com')));

    const res = await login('10.0.0.2', 'ana@example.com');

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ statusCode: 429, error: 'Too Many Requests', message: expect.stringContaining('Demasiados intentos') });
    expect(Number(res.headers['retry-after-account'])).toBeGreaterThan(0);
  });

  it('el email cuenta igual en mayúsculas o con espacios', async () => {
    await statuses(times(10, () => () => login('10.0.0.3', 'ana@example.com')));

    expect((await login('10.0.0.3', '  ANA@Example.com ')).status).toBe(429);
  });

  it('el bloqueo es de esa cuenta en esa IP: otro email, u otra IP con el mismo email, siguen pudiendo', async () => {
    await statuses(times(10, () => () => login('10.0.0.4', 'ana@example.com')));

    expect((await login('10.0.0.4', 'beto@example.com')).status).toBe(401);
    expect((await login('10.0.0.5', 'ana@example.com')).status).toBe(401);
  });

  it('una IP no puede probar más de 50 intentos en total aunque cambie de email', async () => {
    const codes = await statuses(times(51, (i) => () => login('10.0.0.6', `u${i}@example.com`)));

    expect(codes.slice(0, 50).every((code) => code === 401)).toBe(true);
    expect(codes[50]).toBe(429);
  });

  it(`registro: el alta ${REGISTER_LIMIT + 1} desde la misma IP da 429; otra IP sigue pudiendo`, async () => {
    auth.handler = () => ({ status: 201, body: { accessToken: 'jwt' } });

    const codes = await statuses(times(REGISTER_LIMIT + 1, (i) => () => register('10.0.0.7', i)));

    expect(codes.slice(0, REGISTER_LIMIT).every((code) => code === 201)).toBe(true);
    expect(codes[REGISTER_LIMIT]).toBe(429);
    expect((await register('10.0.0.8', 0)).status).toBe(201);
  });

  it('el registro no consume los intentos de login', async () => {
    auth.handler = () => ({ status: 201, body: { accessToken: 'jwt' } });
    await statuses(times(REGISTER_LIMIT, (i) => () => register('10.0.0.9', i)));
    auth.reset(() => ({ status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Credenciales inválidas' } }));

    expect((await login('10.0.0.9', 'ana@example.com')).status).toBe(401);
  });
});
