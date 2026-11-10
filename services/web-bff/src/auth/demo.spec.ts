import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../app.setup';
import { FakeService } from '../test-utils/fake-service';
import { DEMO_LIMIT } from './auth-throttling';
import { DemoAccounts } from './demo-accounts';

describe('DemoAccounts', () => {
  const accounts = (env: Record<string, string>) => new DemoAccounts({ get: (key: string) => env[key] } as unknown as ConfigService);

  it('sin variables no hay ninguna cuenta (desarrollo y CI)', () => {
    expect(accounts({}).available()).toEqual([]);
  });

  it('una cuenta a medio configurar (sin contraseña o con el email vacío) no cuenta', () => {
    const demo = accounts({ DEMO_OWNER_EMAIL: 'dueno@example.com', DEMO_CUSTOMER_EMAIL: '  ', DEMO_CUSTOMER_PASSWORD: 'x' });
    expect(demo.available()).toEqual([]);
    expect(demo.credentials('owner')).toBeUndefined();
  });

  it('devuelve las configuradas, siempre el dueño primero', () => {
    const demo = accounts({
      DEMO_CUSTOMER_EMAIL: 'cliente@example.com',
      DEMO_CUSTOMER_PASSWORD: 'clave-cliente',
      DEMO_OWNER_EMAIL: ' dueno@example.com ',
      DEMO_OWNER_PASSWORD: 'clave-dueno',
    });
    expect(demo.available()).toEqual(['owner', 'customer']);
    expect(demo.credentials('owner')).toEqual({ email: 'dueno@example.com', password: 'clave-dueno' });
  });
});

/** Las rutas de demo con la app real y un auth-service falso. Cada test usa su propia IP, así los límites no se mezclan. */
describe('/auth/demo', () => {
  let app: INestApplication;
  let auth: FakeService;
  let others: FakeService[];
  let ipCounter = 0;
  let ip: string;

  const server = () => request(app.getHttpServer());
  const enter = (role: unknown) => server().post('/auth/demo').set('X-Forwarded-For', ip).send({ role });

  beforeAll(async () => {
    [auth, ...others] = await Promise.all(Array.from({ length: 5 }, () => FakeService.start()));
    Object.assign(process.env, {
      JWT_SECRET: 'bff-test-secret',
      AUTH_SERVICE_URL: auth.url,
      RESTAURANTS_SERVICE_URL: others[0].url,
      RESERVATIONS_SERVICE_URL: others[1].url,
      PAYMENTS_SERVICE_URL: others[2].url,
      NOTIFICATIONS_SERVICE_URL: others[3].url,
      // Solo el dueño: así se prueba también un rol válido que no está configurado
      DEMO_OWNER_EMAIL: 'demo-dueno@example.com',
      DEMO_OWNER_PASSWORD: 'clave-secreta-demo',
      DEMO_CUSTOMER_EMAIL: '',
      DEMO_CUSTOMER_PASSWORD: '',
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

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
    ip = `10.9.0.${++ipCounter}`;
    auth.reset(() => ({ body: { accessToken: 'jwt-demo', user: { id: 'u-demo', role: 'RESTAURANT_OWNER' } } }));
  });

  it('GET dice qué cuentas hay, sin mostrar ningún email ni contraseña', async () => {
    const res = await server().get('/auth/demo');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: ['owner'] });
    expect(JSON.stringify(res.body)).not.toMatch(/demo-dueno|clave-secreta/);
  });

  it('POST entra con las credenciales del entorno y devuelve lo mismo que el login', async () => {
    const res = await enter('owner');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accessToken: 'jwt-demo', user: { id: 'u-demo', role: 'RESTAURANT_OWNER' } });
    expect(auth.calls).toHaveLength(1);
    expect(auth.calls[0]).toMatchObject({
      method: 'POST',
      path: '/auth/login',
      body: { email: 'demo-dueno@example.com', password: 'clave-secreta-demo' },
    });
  });

  it('no le pasa a auth-service el token que el visitante ya tuviera', async () => {
    await enter('owner').set('Authorization', 'Bearer token-del-visitante');

    expect(auth.calls[0].headers.authorization).toBeUndefined();
  });

  it('un rol válido sin cuenta configurada da 404, sin llamar a auth-service', async () => {
    const res = await enter('customer');

    expect(res.status).toBe(404);
    expect(auth.calls).toHaveLength(0);
  });

  it.each([['ADMIN'], ['RESTAURANT_OWNER'], [undefined]])('un rol que no es de demo (%p) da 400', async (role) => {
    const res = await enter(role);

    expect(res.status).toBe(400);
    expect(auth.calls).toHaveLength(0);
  });

  it('si la contraseña del entorno ya no sirve, responde 503 (es un problema nuestro) y no "credenciales inválidas"', async () => {
    auth.reset(() => ({ status: 401, body: { statusCode: 401, error: 'Unauthorized', message: 'Credenciales inválidas' } }));

    const res = await enter('owner');

    expect(res.status).toBe(503);
    expect(res.body.message).toBe('La cuenta de demo no está disponible en este momento');
  });

  it(`después de ${DEMO_LIMIT} entradas desde la misma IP en 15 minutos responde 429`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= DEMO_LIMIT; i++) statuses.push((await enter('owner')).status);

    expect(statuses.slice(0, DEMO_LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses[DEMO_LIMIT]).toBe(429);
  });
});
