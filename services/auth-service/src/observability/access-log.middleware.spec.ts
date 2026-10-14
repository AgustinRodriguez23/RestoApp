import express from 'express';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { accessLogMiddleware } from './access-log.middleware';
import { correlationIdMiddleware } from './correlation-id.middleware';
import { JsonLogger } from './json-logger';
import { setCurrentUserId } from './request-context';

describe('accessLogMiddleware', () => {
  let lines: Record<string, unknown>[];
  const app = express();

  beforeAll(() => {
    app.use(express.json());
    app.use(correlationIdMiddleware, accessLogMiddleware);
    app.get('/ok', (_req, res) => void res.json({ ok: true }));
    app.get('/health', (_req, res) => void res.json({ ok: true }));
    app.get('/missing', (_req, res) => void res.status(404).json({}));
    app.get('/boom', (_req, res) => void res.status(500).json({}));
    app.get('/mine', (_req, res) => {
      setCurrentUserId('user-42'); // lo que hace el guard de JWT
      res.json({});
    });
    app.post('/login', (_req, res) => void res.json({ accessToken: 'secreto' }));
  });

  beforeEach(() => {
    lines = [];
    Logger.overrideLogger(new JsonLogger({ service: 'svc', level: 'debug', write: (l) => lines.push(JSON.parse(l)) }));
  });
  afterAll(() => Logger.overrideLogger(false));

  it('registra método, ruta, status, duración y correlationId al terminar', async () => {
    await request(app).get('/ok').set('x-correlation-id', 'trace-12345678');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      context: 'HTTP',
      message: 'request completed',
      method: 'GET',
      path: '/ok',
      status: 200,
      correlationId: 'trace-12345678',
    });
    expect(lines[0].durationMs).toEqual(expect.any(Number));
  });

  it('4xx es warn y 5xx es error', async () => {
    await request(app).get('/missing');
    await request(app).get('/boom');

    expect(lines.map((l) => [l.level, l.status])).toEqual([['warn', 404], ['error', 500]]);
  });

  it('incluye el userId que completó el guard durante la request', async () => {
    await request(app).get('/mine');

    expect(lines[0]).toMatchObject({ userId: 'user-42' });
  });

  it('NO registra query string, body ni headers (pueden tener secretos)', async () => {
    await request(app).post('/login?token=abc123&email=a@b.com').set('Authorization', 'Bearer eyJsecreto').send({ password: 'Password123' });

    const text = JSON.stringify(lines);
    expect(lines[0]).toMatchObject({ path: '/login' });
    expect(text).not.toMatch(/abc123|a@b\.com|eyJsecreto|Password123|secreto/);
  });

  it('el health check queda en nivel debug (no ensucia los logs normales)', async () => {
    await request(app).get('/health');

    expect(lines[0]).toMatchObject({ level: 'debug', path: '/health' });
  });

  it('cada request simultánea queda con su propio correlationId', async () => {
    await Promise.all(['aaaa-11111111', 'bbbb-22222222', 'cccc-33333333'].map((id) => request(app).get('/ok').set('x-correlation-id', id)));

    expect(lines.map((l) => l.correlationId).sort()).toEqual(['aaaa-11111111', 'bbbb-22222222', 'cccc-33333333']);
  });
});
