import { ConfigService } from '@nestjs/config';
import { DepositPolicy } from './deposit-policy';

const policy = (env: Record<string, string> = {}) =>
  new DepositPolicy({ get: (name: string) => env[name] } as unknown as ConfigService);

const NOW = new Date('2026-10-12T15:00:00Z');
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

describe('DepositPolicy', () => {
  it('por defecto no cobra seña (la reserva nace confirmada)', () => {
    const p = policy();
    expect(p.perPersonCents).toBe(0);
    expect(p.amountFor(4)).toBe(0);
    expect(p.currency).toBe('ARS');
    expect(p.paymentWindowMinutes).toBe(15);
    expect(p.refundCutoffHours).toBe(24);
  });

  it('la seña es por persona', () => {
    expect(policy({ DEPOSIT_PER_PERSON_CENTS: '200000' }).amountFor(3)).toBe(600000);
  });

  it.each(['-1', '1.5', 'abc'])('rechaza una seña inválida (%s)', (value) => {
    expect(() => policy({ DEPOSIT_PER_PERSON_CENTS: value })).toThrow(/DEPOSIT_PER_PERSON_CENTS/);
  });

  it('la ventana de pago tiene que ser mayor a 0', () => {
    expect(() => policy({ PAYMENT_WINDOW_MINUTES: '0' })).toThrow(/PAYMENT_WINDOW_MINUTES/);
  });

  it('por defecto un cliente puede tener 3 reservas esperando el pago; se configura con MAX_PENDING_RESERVATIONS', () => {
    expect(policy().maxPendingPerCustomer).toBe(3);
    expect(policy({ MAX_PENDING_RESERVATIONS: '5' }).maxPendingPerCustomer).toBe(5);
  });

  it.each(['0', '-1', 'abc'])('rechaza un tope de pendientes inválido (%s)', (value) => {
    expect(() => policy({ MAX_PENDING_RESERVATIONS: value })).toThrow(/MAX_PENDING_RESERVATIONS/);
  });

  describe('isRefundable', () => {
    const p = policy({ REFUND_CUTOFF_HOURS: '24' });

    it('el cliente que cancela con anticipación suficiente recupera la seña', () => {
      expect(p.isRefundable(inHours(48), false, NOW)).toBe(true);
    });

    it('justo en el límite de 24 h todavía se devuelve', () => {
      expect(p.isRefundable(inHours(24), false, NOW)).toBe(true);
    });

    it('con menos de 24 h el cliente pierde la seña', () => {
      expect(p.isRefundable(new Date(inHours(24).getTime() - 1), false, NOW)).toBe(false);
    });

    it('si cancela el restaurante se devuelve siempre', () => {
      expect(p.isRefundable(inHours(1), true, NOW)).toBe(true);
    });
  });
});
