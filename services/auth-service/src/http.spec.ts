import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JsonLogger } from './observability/json-logger';

describe('auth-service HTTP: formato de error y trazabilidad', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let lines: Record<string, unknown>[];
  const auth = { register: jest.fn(), login: jest.fn(), getProfile: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), JwtModule.register({ secret: 'test-secret' })],
      controllers: [AuthController],
      providers: [JwtAuthGuard, { provide: AuthService, useValue: auth }],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = moduleRef.get(JwtService);
  });
  afterAll(() => app.close());

  beforeEach(() => {
    lines = [];
    Logger.overrideLogger(new JsonLogger({ service: 'auth-service', level: 'debug', write: (l) => lines.push(JSON.parse(l)) }));
  });
  afterEach(() => Logger.overrideLogger(false));

  it('devuelve el x-correlation-id y lo usa en el log de la request', async () => {
    auth.login.mockResolvedValue({ accessToken: 'jwt-secreto' });

    const res = await request(app.getHttpServer()).post('/auth/login').set('x-correlation-id', 'traza-auth-0001').send({ email: 'a@b.com', password: 'Password123' });

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('traza-auth-0001');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'auth-service', message: 'request completed', path: '/auth/login', status: 200, correlationId: 'traza-auth-0001' });
  });

  it('nunca loguea la contraseña ni el token', async () => {
    auth.login.mockResolvedValue({ accessToken: 'jwt-secreto' });

    await request(app.getHttpServer()).post('/auth/login').send({ email: 'a@b.com', password: 'ContraseñaSecreta123' });

    expect(JSON.stringify(lines)).not.toMatch(/ContraseñaSecreta123|jwt-secreto/);
  });

  it('un usuario autenticado queda identificado en el log', async () => {
    auth.getProfile.mockResolvedValue({ id: 'user-5' });
    const token = jwt.sign({ sub: 'user-5', email: 'a@b.com', role: 'CUSTOMER' });

    await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${token}`);

    expect(lines[0]).toMatchObject({ userId: 'user-5', status: 200 });
  });

  it('un 400 de validación se registra como warn', async () => {
    const res = await request(app.getHttpServer()).post('/auth/register').send({ email: 'no-es-mail' });

    expect(res.status).toBe(400);
    expect(lines[0]).toMatchObject({ level: 'warn', status: 400 });
    expect(lines[0].correlationId).toEqual(expect.any(String));
  });
});
