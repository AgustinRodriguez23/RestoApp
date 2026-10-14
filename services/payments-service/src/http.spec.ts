import { ConflictException, INestApplication, NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { InvalidWebhookError } from './gateway/payment-gateway';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { WebhooksController } from './payments/webhooks.controller';
import { WebhooksService } from './payments/webhooks.service';
import { Role } from './security/role.enum';
import { SecurityModule } from './security/security.module';

const PAYMENT_ID = '9b2c3d4e-1111-4c0e-9d3a-7a1f2b6c9d10';
const KEY = 'b1f6d3a0-5c1e-4f6e-9a55-2f1d7c1e8a10';
const paymentDto = (status = 'SUCCEEDED') => ({ id: PAYMENT_ID, status });

describe('HTTP (controllers + guards + validación + filtro de errores)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let payments: Record<'pay' | 'findOne' | 'findByReservation', jest.Mock>;
  let webhooks: { handle: jest.Mock };

  const auth = () => `Bearer ${jwt.sign({ sub: 'user-1', email: 'u@example.com', role: Role.CUSTOMER })}`;
  const pay = (body: object = { token: 'tok_approved' }, key: string | null = KEY) => {
    const req = request(app.getHttpServer()).post(`/payments/${PAYMENT_ID}/pay`).set('Authorization', auth());
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  beforeAll(async () => {
    payments = { pay: jest.fn(), findOne: jest.fn(), findByReservation: jest.fn() };
    webhooks = { handle: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: 'test-secret' })] }),
        SecurityModule,
      ],
      controllers: [PaymentsController, WebhooksController],
      providers: [
        { provide: PaymentsService, useValue: payments },
        { provide: WebhooksService, useValue: webhooks },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true }); // igual que main.ts
    configureApp(app);
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  describe('autenticación', () => {
    it.each([
      ['GET', `/payments/${PAYMENT_ID}`],
      ['GET', `/payments/by-reservation/${PAYMENT_ID}`],
      ['POST', `/payments/${PAYMENT_ID}/pay`],
    ])('%s %s sin token responde 401', async (method, path) => {
      const res = await request(app.getHttpServer())[method.toLowerCase() as 'get' | 'post'](path).set('Idempotency-Key', KEY).send({ token: 'tok_approved' });

      expect(res.status).toBe(401);
    });

    it('un token inválido responde 401', async () => {
      const res = await request(app.getHttpServer()).get(`/payments/${PAYMENT_ID}`).set('Authorization', 'Bearer basura');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /payments/:id/pay', () => {
    it('cobra con el usuario del token, el token de pago y la Idempotency-Key', async () => {
      payments.pay.mockResolvedValue({ status: 200, body: paymentDto(), replayed: false });

      const res = await pay();

      expect(res.status).toBe(200);
      expect(res.body).toEqual(paymentDto());
      expect(payments.pay).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1' }), PAYMENT_ID, 'tok_approved', KEY);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    });

    it('si la pasarela queda pendiente responde 202', async () => {
      payments.pay.mockResolvedValue({ status: 202, body: paymentDto('PROCESSING'), replayed: false });

      expect((await pay()).status).toBe(202);
    });

    it('una respuesta repetida lleva el header Idempotent-Replayed', async () => {
      payments.pay.mockResolvedValue({ status: 200, body: paymentDto(), replayed: true });

      expect((await pay()).headers['idempotent-replayed']).toBe('true');
    });

    it('sin Idempotency-Key responde 400 y NO llega al servicio', async () => {
      const res = await pay({ token: 'tok_approved' }, null);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Idempotency-Key');
      expect(payments.pay).not.toHaveBeenCalled();
    });

    it.each(['corta', 'con espacios no vale', 'x'.repeat(101), 'raro/con*simbolos'])('rechaza una Idempotency-Key inválida (%s)', async (key) => {
      expect((await pay({ token: 'tok_approved' }, key)).status).toBe(400);
      expect(payments.pay).not.toHaveBeenCalled();
    });

    it.each([{}, { token: '' }, { token: 123 }, { token: 'x'.repeat(101) }])('rechaza un token de pago inválido (%j)', async (body) => {
      expect((await pay(body)).status).toBe(400);
      expect(payments.pay).not.toHaveBeenCalled();
    });

    it('rechaza propiedades de más (no se puede mandar un importe propio)', async () => {
      const res = await pay({ token: 'tok_approved', amountCents: 1 });

      expect(res.status).toBe(400);
      expect(payments.pay).not.toHaveBeenCalled();
    });

    it('un id que no es UUID responde 400', async () => {
      const res = await request(app.getHttpServer()).post('/payments/no-es-uuid/pay').set('Authorization', auth()).set('Idempotency-Key', KEY).send({ token: 'tok_approved' });

      expect(res.status).toBe(400);
    });

    it('los errores del servicio salen con el formato común', async () => {
      payments.pay.mockRejectedValue(new ConflictException('Este pago no se puede cobrar: está SUCCEEDED'));

      const res = await pay();

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ statusCode: 409, error: 'Conflict', message: 'Este pago no se puede cobrar: está SUCCEEDED', path: `/payments/${PAYMENT_ID}/pay` });
    });
  });

  describe('consultas', () => {
    it('GET /payments/:id', async () => {
      payments.findOne.mockResolvedValue(paymentDto());

      const res = await request(app.getHttpServer()).get(`/payments/${PAYMENT_ID}`).set('Authorization', auth());

      expect(res.status).toBe(200);
      expect(payments.findOne).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({ sub: 'user-1' }));
    });

    it('GET /payments/by-reservation/:id propaga el 404', async () => {
      payments.findByReservation.mockRejectedValue(new NotFoundException('Pago no encontrado'));

      const res = await request(app.getHttpServer()).get(`/payments/by-reservation/${PAYMENT_ID}`).set('Authorization', auth());

      expect(res.status).toBe(404);
    });
  });

  describe('POST /webhooks/gateway', () => {
    const body = JSON.stringify({ eventId: 'evt_1', type: 'charge.succeeded', chargeId: 'ch_1' });

    it('entrega al servicio los bytes EXACTOS recibidos (la firma se calcula sobre ellos) y no pide JWT', async () => {
      webhooks.handle.mockResolvedValue('applied');
      const odd = '{ "eventId":"evt_1",  "type":"charge.succeeded", "chargeId":"ch_1" }'; // espacios raros: cambian la firma si se re-serializa

      const res = await request(app.getHttpServer())
        .post('/webhooks/gateway')
        .set('Content-Type', 'application/json')
        .set('x-gateway-signature', 't=1,v1=abc')
        .send(odd);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, result: 'applied' });
      const [raw, headers] = webhooks.handle.mock.calls[0];
      expect(Buffer.isBuffer(raw)).toBe(true);
      expect(raw.toString()).toBe(odd);
      expect(headers['x-gateway-signature']).toBe('t=1,v1=abc');
    });

    it('una firma inválida responde 401', async () => {
      webhooks.handle.mockRejectedValue(new InvalidWebhookError('la firma del webhook no coincide'));

      const res = await request(app.getHttpServer()).post('/webhooks/gateway').set('Content-Type', 'application/json').send(body);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('la firma del webhook no coincide');
    });

    it('un cuerpo que no es JSON responde 400 (y no 500)', async () => {
      webhooks.handle.mockRejectedValue(new SyntaxError('Unexpected token'));

      const res = await request(app.getHttpServer()).post('/webhooks/gateway').set('Content-Type', 'application/json').send(body);

      expect(res.status).toBe(400);
    });

    it('si el cobro no existe todavía responde 404 (la pasarela reintenta)', async () => {
      webhooks.handle.mockRejectedValue(new NotFoundException('No hay un pago para el cobro ch_1'));

      expect((await request(app.getHttpServer()).post('/webhooks/gateway').set('Content-Type', 'application/json').send(body)).status).toBe(404);
    });
  });
});
