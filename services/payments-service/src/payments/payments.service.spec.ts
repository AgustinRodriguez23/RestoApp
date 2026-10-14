import { ConflictException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PAYMENT_GATEWAY } from '../gateway/payment-gateway';
import { OutboxService } from '../messaging/outbox.service';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { IdempotencyService } from './idempotency.service';
import { PaymentsService } from './payments.service';

const payment = (overrides: Partial<Payment> = {}): Payment =>
  ({
    id: 'pay-1',
    reservationId: 'res-1',
    customerId: 'c1',
    amountCents: 15000,
    status: PaymentStatus.SUCCEEDED,
    providerChargeId: 'ch_1',
    providerRefundId: null,
    failureReason: null,
    paidAt: null,
    refundedAt: null,
    ...overrides,
  }) as Payment;

describe('PaymentsService (reglas de estado, con mocks)', () => {
  let service: PaymentsService;
  let gateway: { name: string; refund: jest.Mock; createCharge: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let save: jest.Mock;
  const manager = { getRepository: () => ({ save }) } as never;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    gateway = { name: 'simulated', refund: jest.fn().mockResolvedValue({ refundId: 're_1' }), createCharge: jest.fn() };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    save = jest.fn(async (p: Payment) => p);

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: {} },
        { provide: PAYMENT_GATEWAY, useValue: gateway },
        { provide: OutboxService, useValue: outbox },
        { provide: IdempotencyService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(PaymentsService);
  });

  describe('refund', () => {
    it('devuelve con una clave estable por pago, guarda el resultado y emite payment.refunded', async () => {
      const p = payment();

      await service.refund(manager, p, 'CANCELLED_BY_CUSTOMER');

      expect(gateway.refund).toHaveBeenCalledWith({ chargeId: 'ch_1', amountCents: 15000, idempotencyKey: 'refund-pay-1' });
      expect(p).toMatchObject({ status: PaymentStatus.REFUNDED, providerRefundId: 're_1' });
      expect(p.refundedAt).toBeInstanceOf(Date);
      expect(save).toHaveBeenCalledWith(p);
      expect(outbox.enqueue).toHaveBeenCalledWith(manager, 'payment.refunded', expect.objectContaining({ paymentId: 'pay-1', amountCents: 15000, reason: 'CANCELLED_BY_CUSTOMER' }));
    });

    it('es idempotente: si ya estaba devuelto no llama a la pasarela ni emite nada', async () => {
      await service.refund(manager, payment({ status: PaymentStatus.REFUNDED }), 'X');

      expect(gateway.refund).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it.each([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED])(
      'no se puede devolver un pago %s (nunca se cobró)',
      async (status) => {
        await expect(service.refund(manager, payment({ status }), 'X')).rejects.toBeInstanceOf(ConflictException);
        expect(gateway.refund).not.toHaveBeenCalled();
      },
    );

    it('si la pasarela falla, el pago NO queda marcado como devuelto y no se emite el evento', async () => {
      gateway.refund.mockRejectedValue(new Error('pasarela caída'));
      const p = payment();

      await expect(service.refund(manager, p, 'X')).rejects.toThrow('pasarela caída');

      expect(p.status).toBe(PaymentStatus.SUCCEEDED);
      expect(save).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('un pago cobrado pero sin id de cobro en la pasarela es un error (no se inventa una devolución)', async () => {
      await expect(service.refund(manager, payment({ providerChargeId: null }), 'X')).rejects.toThrow(/no tiene cobro/);
    });
  });

  describe('settle', () => {
    it('aprobado: SUCCEEDED, fecha de pago y payment.succeeded con el importe', async () => {
      const p = payment({ status: PaymentStatus.PROCESSING });

      await service.settle(manager, p, { ok: true });

      expect(p.status).toBe(PaymentStatus.SUCCEEDED);
      expect(p.paidAt).toBeInstanceOf(Date);
      expect(outbox.enqueue).toHaveBeenCalledWith(manager, 'payment.succeeded', { paymentId: 'pay-1', reservationId: 'res-1', amountCents: 15000 });
    });

    it('rechazado: FAILED con el motivo (recortado) y payment.failed', async () => {
      const p = payment({ status: PaymentStatus.PENDING });

      await service.settle(manager, p, { ok: false, reason: 'x'.repeat(500) });

      expect(p.status).toBe(PaymentStatus.FAILED);
      expect(p.failureReason).toHaveLength(200);
      expect(outbox.enqueue).toHaveBeenCalledWith(manager, 'payment.failed', expect.objectContaining({ paymentId: 'pay-1', reservationId: 'res-1' }));
    });

    it.each([PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.REFUNDED, PaymentStatus.EXPIRED])('no se puede resolver un pago ya %s', async (status) => {
      await expect(service.settle(manager, payment({ status }), { ok: true })).rejects.toBeInstanceOf(ConflictException);
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });
  });
});
