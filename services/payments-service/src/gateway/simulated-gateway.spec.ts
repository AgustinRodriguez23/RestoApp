import { ConfigService } from '@nestjs/config';
import { createGateway } from './gateway.module';
import { GatewayUnavailableError, InvalidWebhookError } from './payment-gateway';
import { SimulatedGateway } from './simulated-gateway';
import { signWebhook, SIGNATURE_HEADER, verifyWebhookSignature } from './webhook-signature';

const SECRET = 'whsec_test';
const input = (token: string, idempotencyKey = 'pay-1') => ({
  paymentId: 'p1',
  amountCents: 15000,
  currency: 'ARS',
  token,
  idempotencyKey,
});

describe('SimulatedGateway', () => {
  let fetchFn: jest.Mock;
  let gateway: SimulatedGateway;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchFn = jest.fn(async () => new Response('{}', { status: 200 }));
    gateway = new SimulatedGateway({ webhookSecret: SECRET, webhookUrl: 'http://hook.local/webhooks/gateway', webhookDelayMs: 3000, fetchFn });
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('cobros según el token', () => {
    it('tok_approved aprueba al instante', async () => {
      expect(await gateway.createCharge(input('tok_approved'))).toEqual({ status: 'succeeded', chargeId: expect.stringMatching(/^ch_/) });
    });

    it.each([
      ['tok_declined', 'card_declined'],
      ['tok_insufficient_funds', 'insufficient_funds'],
      ['tok_cualquiera', 'invalid_token'],
    ])('%s se rechaza con motivo %s', async (token, reason) => {
      expect(await gateway.createCharge(input(token))).toMatchObject({ status: 'failed', reason });
    });

    it('tok_error simula una pasarela caída y NO deja registrado el cobro (el reintento vuelve a intentar)', async () => {
      await expect(gateway.createCharge(input('tok_error'))).rejects.toBeInstanceOf(GatewayUnavailableError);

      expect(await gateway.createCharge(input('tok_approved'))).toMatchObject({ status: 'succeeded' });
    });
  });

  it('con la misma clave de idempotencia devuelve el mismo cobro (no cobra dos veces)', async () => {
    const first = await gateway.createCharge(input('tok_approved', 'k1'));
    const second = await gateway.createCharge(input('tok_approved', 'k1'));
    const other = await gateway.createCharge(input('tok_approved', 'k2'));

    expect(second).toEqual(first);
    expect(other).not.toEqual(first);
  });

  describe('webhooks', () => {
    it('tok_slow queda pendiente y recién pasado el retraso llama al webhook, firmado', async () => {
      const charge = await gateway.createCharge(input('tok_slow'));
      expect(charge.status).toBe('pending');

      await jest.advanceTimersByTimeAsync(2999);
      expect(fetchFn).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('http://hook.local/webhooks/gateway');
      const sent = JSON.parse(init.body);
      expect(sent).toMatchObject({ type: 'charge.succeeded', chargeId: charge.chargeId, eventId: expect.stringMatching(/^evt_/) });
      expect(() => verifyWebhookSignature(SECRET, Buffer.from(init.body), init.headers[SIGNATURE_HEADER])).not.toThrow();
    });

    it('tok_slow_declined avisa el rechazo con su motivo', async () => {
      await gateway.createCharge(input('tok_slow_declined'));
      await jest.advanceTimersByTimeAsync(3000);

      expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toMatchObject({ type: 'charge.failed', failureReason: 'card_declined' });
    });

    it('tok_slow_duplicate envía el MISMO evento dos veces (mismo eventId)', async () => {
      await gateway.createCharge(input('tok_slow_duplicate'));
      await jest.advanceTimersByTimeAsync(3000);

      expect(fetchFn).toHaveBeenCalledTimes(2);
      const ids = fetchFn.mock.calls.map(([, init]) => JSON.parse(init.body).eventId);
      expect(ids[0]).toBe(ids[1]);
    });

    it('repetir el pedido de cobro con la misma clave NO programa otro webhook', async () => {
      await gateway.createCharge(input('tok_slow', 'k'));
      await gateway.createCharge(input('tok_slow', 'k'));
      await jest.advanceTimersByTimeAsync(3000);

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('si el comercio no responde, el error no rompe al servicio', async () => {
      fetchFn.mockRejectedValue(new Error('ECONNREFUSED'));
      await gateway.createCharge(input('tok_slow'));

      await expect(jest.advanceTimersByTimeAsync(3000)).resolves.not.toThrow();
    });

    it('al apagar el servicio se cancelan los webhooks pendientes', async () => {
      await gateway.createCharge(input('tok_slow'));
      gateway.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5000);

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('parseWebhook devuelve el evento si la firma es buena y lanza InvalidWebhookError si no', () => {
      const body = JSON.stringify({ eventId: 'evt_1', type: 'charge.succeeded', chargeId: 'ch_1' });

      expect(gateway.parseWebhook(Buffer.from(body), { [SIGNATURE_HEADER]: signWebhook(SECRET, body) })).toEqual({
        eventId: 'evt_1',
        type: 'charge.succeeded',
        chargeId: 'ch_1',
      });
      expect(() => gateway.parseWebhook(Buffer.from(body), { [SIGNATURE_HEADER]: signWebhook('otro', body) })).toThrow(InvalidWebhookError);
      expect(() => gateway.parseWebhook(Buffer.from(body), {})).toThrow(InvalidWebhookError);
    });
  });

  it('devolver con la misma clave no devuelve dos veces', async () => {
    const a = await gateway.refund({ chargeId: 'ch_1', amountCents: 100, idempotencyKey: 'refund-1' });
    const b = await gateway.refund({ chargeId: 'ch_1', amountCents: 100, idempotencyKey: 'refund-1' });

    expect(b).toEqual(a);
    expect(a.refundId).toMatch(/^re_/);
  });
});

describe('createGateway (elección de la pasarela por configuración)', () => {
  const config = (env: Record<string, string>) => ({ get: (k: string) => env[k], getOrThrow: (k: string) => {
    if (!env[k]) throw new Error(`falta ${k}`);
    return env[k];
  } }) as unknown as ConfigService;

  it('por defecto usa la simulada', () => {
    expect(createGateway(config({ GATEWAY_WEBHOOK_SECRET: 's' })).name).toBe('simulated');
  });

  it('PAYMENT_PROVIDER=simulated también', () => {
    expect(createGateway(config({ PAYMENT_PROVIDER: 'simulated', GATEWAY_WEBHOOK_SECRET: 's' })).name).toBe('simulated');
  });

  it('una pasarela desconocida hace fallar el arranque, listando las opciones', () => {
    expect(() => createGateway(config({ PAYMENT_PROVIDER: 'mercadopago', GATEWAY_WEBHOOK_SECRET: 's' }))).toThrow(/no está soportado.*simulated/);
  });

  it('en producción la simulada no arranca si no se aceptó a conciencia', () => {
    expect(() => createGateway(config({ NODE_ENV: 'production', GATEWAY_WEBHOOK_SECRET: 's' }))).toThrow(/ALLOW_SIMULATED_GATEWAY/);
  });

  it('en producción la simulada arranca con ALLOW_SIMULATED_GATEWAY=true (demo)', () => {
    const env = { NODE_ENV: 'production', ALLOW_SIMULATED_GATEWAY: 'true', GATEWAY_WEBHOOK_SECRET: 's' };
    expect(createGateway(config(env)).name).toBe('simulated');
  });

  it('sin secreto de webhook no arranca (no se acepta un secreto por defecto)', () => {
    expect(() => createGateway(config({}))).toThrow(/GATEWAY_WEBHOOK_SECRET/);
  });
});
