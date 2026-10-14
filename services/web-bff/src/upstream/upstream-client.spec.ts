import { BadGatewayException, HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakeService } from '../test-utils/fake-service';
import { UpstreamClient } from './upstream-client';

describe('UpstreamClient (contra un servidor HTTP real)', () => {
  let fake: FakeService;
  let client: UpstreamClient;

  const makeClient = (env: Record<string, string> = {}) =>
    new UpstreamClient({ get: (key: string) => ({ UPSTREAM_TIMEOUT_MS: '300', UPSTREAM_RETRY_DELAY_MS: '0', AUTH_SERVICE_URL: fake.url + '/', ...env })[key] } as unknown as ConfigService);

  const failure = async (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e as HttpException);

  beforeAll(async () => {
    fake = await FakeService.start();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    await fake.stop();
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    fake.reset(() => ({ body: { ok: true } }));
    client = makeClient();
  });

  it('hace el GET a la URL correcta y devuelve el JSON', async () => {
    fake.reset(() => ({ body: { id: 1 } }));

    await expect(client.call('auth', { path: '/auth/me' })).resolves.toEqual({ id: 1 });
    expect(fake.calls[0]).toMatchObject({ method: 'GET', path: '/auth/me' });
  });

  it('reenvía el token del usuario y el correlation id', async () => {
    await client.call('auth', { path: '/x' }, { token: 'abc.def.ghi', correlationId: 'corr-12345678' });

    expect(fake.calls[0].headers.authorization).toBe('Bearer abc.def.ghi');
    expect(fake.calls[0].headers['x-correlation-id']).toBe('corr-12345678');
  });

  it('sin token no manda Authorization', async () => {
    await client.call('auth', { path: '/x' });

    expect(fake.calls[0].headers.authorization).toBeUndefined();
  });

  it('arma la query, omitiendo los valores vacíos y escapando los caracteres especiales', async () => {
    await client.call('auth', { path: '/x', query: { search: 'pan & vino', page: 2, cuisine: undefined, empty: '' } });

    expect(fake.calls[0].path).toBe('/x?search=pan+%26+vino&page=2');
  });

  it('reenvía headers extra (Idempotency-Key) y callWithStatus devuelve el status exacto', async () => {
    fake.reset(() => ({ status: 202, body: { id: 'p1' } }));

    const res = await client.callWithStatus('auth', { method: 'POST', path: '/pay', body: {}, headers: { 'Idempotency-Key': 'k-12345678' } });

    expect(res).toMatchObject({ status: 202, body: { id: 'p1' } });
    expect(fake.calls[0].headers['idempotency-key']).toBe('k-12345678');
  });

  it('los servicios de pagos se encuentran por PAYMENTS_SERVICE_URL', async () => {
    client = makeClient({ PAYMENTS_SERVICE_URL: fake.url });

    await client.call('payments', { path: '/payments/x' });

    expect(fake.calls[0].path).toBe('/payments/x');
  });

  it('envía el body de un POST como JSON', async () => {
    await client.call('auth', { method: 'POST', path: '/auth/login', body: { email: 'a@b.com' } });

    expect(fake.calls[0]).toMatchObject({ method: 'POST', body: { email: 'a@b.com' } });
    expect(fake.calls[0].headers['content-type']).toBe('application/json');
  });

  describe('errores del servicio (4xx): se devuelven tal cual', () => {
    it('conserva status, error y mensaje', async () => {
      fake.reset(() => ({ status: 409, body: { statusCode: 409, error: 'Conflict', message: 'No hay mesas disponibles' } }));

      const error = await failure(client.call('auth', { method: 'POST', path: '/x', body: {} }));

      expect(error).toBeInstanceOf(HttpException);
      expect(error!.getStatus()).toBe(409);
      expect(error!.getResponse()).toMatchObject({ error: 'Conflict', message: 'No hay mesas disponibles' });
    });

    it('conserva la lista de mensajes de validación', async () => {
      fake.reset(() => ({ status: 400, body: { message: ['email must be an email', 'name too short'] } }));

      const error = await failure(client.call('auth', { path: '/x' }));

      expect((error!.getResponse() as { message: string[] }).message).toHaveLength(2);
    });

    it('un 4xx NO se reintenta', async () => {
      fake.reset(() => ({ status: 404, body: { message: 'no existe' } }));

      await failure(client.call('auth', { path: '/x' }));

      expect(fake.calls).toHaveLength(1);
    });
  });

  describe('fallas del servicio (5xx, red, timeout)', () => {
    it('un GET con 500 se reintenta una vez y, si se recupera, devuelve el resultado', async () => {
      let n = 0;
      fake.reset(() => (++n === 1 ? { status: 500, body: {} } : { body: { ok: 'recuperado' } }));

      await expect(client.call('auth', { path: '/x' })).resolves.toEqual({ ok: 'recuperado' });
      expect(fake.calls).toHaveLength(2);
    });

    it('si el GET sigue fallando, responde 502 después de 2 intentos', async () => {
      fake.reset(() => ({ status: 503, body: {} }));

      const error = await failure(client.call('auth', { path: '/x' }));

      expect(error!.getStatus()).toBe(502);
      expect(fake.calls).toHaveLength(2);
    });

    it('un POST con 500 NO se reintenta (podría duplicar la operación)', async () => {
      fake.reset(() => ({ status: 500, body: {} }));

      const error = await failure(client.call('auth', { method: 'POST', path: '/x', body: {} }));

      expect(error!.getStatus()).toBe(502);
      expect(fake.calls).toHaveLength(1);
    });

    it('si el servicio tarda más que el timeout responde 504', async () => {
      fake.reset(() => ({ body: {}, delayMs: 1000 }));

      const started = Date.now();
      const error = await failure(client.call('auth', { method: 'POST', path: '/x', body: {} }));

      expect(error!.getStatus()).toBe(504);
      expect(Date.now() - started).toBeLessThan(900); // no esperó la respuesta lenta
    });

    it('si no se puede conectar responde 503', async () => {
      const dead = makeClient({ AUTH_SERVICE_URL: 'http://127.0.0.1:1' });

      const error = await failure(dead.call('auth', { path: '/x' }));

      expect(error!.getStatus()).toBe(503);
    });

    it('una respuesta que no es JSON es un 502', async () => {
      fake.reset(() => ({ raw: '<html>error</html>' }));

      const error = await failure(client.call('auth', { path: '/x' }));

      expect(error).toBeInstanceOf(BadGatewayException);
    });

    it('los mensajes de error no revelan direcciones internas', async () => {
      fake.reset(() => ({ status: 500, body: {} }));

      const error = await failure(client.call('auth', { path: '/x' }));

      expect(JSON.stringify(error!.getResponse())).not.toMatch(/127\.0\.0\.1|http:/);
    });
  });

  it('usa la URL por defecto de cada servicio si no hay variable de entorno', async () => {
    const defaults = new UpstreamClient({ get: () => undefined } as unknown as ConfigService);
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));

    await defaults.call('restaurants', { path: '/a' });
    await defaults.call('reservations', { path: '/b' });

    expect(spy.mock.calls.map(([url]) => String(url))).toEqual(['http://localhost:3002/a', 'http://localhost:3003/b']);
    spy.mockRestore();
  });
});
