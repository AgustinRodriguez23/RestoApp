import { ConflictException } from '@nestjs/common';
import { PaymentStatus } from './entities/payment-status.enum';
import { assertTransition, canTransition } from './payment-state';

const { PENDING, PROCESSING, SUCCEEDED, FAILED, EXPIRED, CANCELLED, REFUNDED } = PaymentStatus;

describe('máquina de estados del pago', () => {
  it.each([
    [PENDING, PROCESSING],
    [PENDING, SUCCEEDED],
    [PENDING, FAILED],
    [PENDING, EXPIRED],
    [PENDING, CANCELLED],
    [PROCESSING, SUCCEEDED],
    [PROCESSING, FAILED],
    [SUCCEEDED, REFUNDED],
  ])('permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([FAILED, EXPIRED, CANCELLED, REFUNDED])('%s es final', (final) => {
    for (const to of Object.values(PaymentStatus)) expect(canTransition(final, to)).toBe(false);
  });

  it('no se puede devolver un pago que no se cobró', () => {
    for (const from of [PENDING, PROCESSING, FAILED, EXPIRED, CANCELLED]) {
      expect(canTransition(from, REFUNDED)).toBe(false);
    }
  });

  it('un pago en proceso no puede vencer ni cancelarse: lo resuelve el webhook', () => {
    expect(canTransition(PROCESSING, EXPIRED)).toBe(false);
    expect(canTransition(PROCESSING, CANCELLED)).toBe(false);
  });

  it('un pago cobrado no vuelve a cobrarse', () => {
    expect(canTransition(SUCCEEDED, SUCCEEDED)).toBe(false);
    expect(canTransition(SUCCEEDED, PROCESSING)).toBe(false);
  });

  it('assertTransition responde 409 diciendo de dónde a dónde', () => {
    expect(() => assertTransition(FAILED, SUCCEEDED)).toThrow(ConflictException);
    expect(() => assertTransition(FAILED, SUCCEEDED)).toThrow(/FAILED a SUCCEEDED/);
  });
});
