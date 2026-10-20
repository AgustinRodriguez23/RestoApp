import { EventEnvelope, PoisonMessageError } from '../messaging/event-envelope';
import { buildNotification, formatWhen } from './notification-templates';

const envelope = (type: string, data: Record<string, unknown>): EventEnvelope => ({
  id: 'evt-1',
  type,
  occurredAt: '2026-10-20T12:00:00.000Z',
  correlationId: 'corr-1',
  data,
});

// Sábado 31/10/2026 21:30 en Buenos Aires = 00:30 UTC del domingo 01/11
const STARTS_AT = '2026-11-01T00:30:00.000Z';
const base = {
  reservationId: 'res-1',
  customerId: 'cust-1',
  restaurantId: 'rest-1',
  restaurantName: 'La Parrilla',
  startsAt: STARTS_AT,
  partySize: 4,
  timeZone: 'America/Argentina/Buenos_Aires',
};

describe('formatWhen', () => {
  it('muestra día y hora en la zona del restaurante, no en UTC', () => {
    expect(formatWhen(STARTS_AT, 'America/Argentina/Buenos_Aires')).toBe('sábado 31 de octubre a las 21:30');
  });

  it('la misma hora en otra zona da otro día y hora (prueba que la zona se usa)', () => {
    expect(formatWhen(STARTS_AT, 'UTC')).toBe('domingo 1 de noviembre a las 00:30');
  });

  it('medianoche se muestra como 00:xx y no como 24:xx', () => {
    expect(formatWhen('2026-11-01T03:05:00.000Z', 'America/Argentina/Buenos_Aires')).toBe('domingo 1 de noviembre a las 00:05');
  });

  it('una zona inválida cae a Buenos Aires en vez de perder la notificación', () => {
    expect(formatWhen(STARTS_AT, 'No/Existe')).toBe('sábado 31 de octubre a las 21:30');
  });

  it('sin zona usa Buenos Aires', () => {
    expect(formatWhen(STARTS_AT, undefined)).toBe('sábado 31 de octubre a las 21:30');
  });

  it.each([undefined, null, '', '   ', 'no es una fecha', 123])('con %p devuelve undefined', (value) => {
    expect(formatWhen(value, 'UTC')).toBeUndefined();
  });
});

describe('buildNotification', () => {
  describe('reservation.confirmed', () => {
    it('avisa al cliente con restaurante, personas y horario', () => {
      expect(buildNotification(envelope('reservation.confirmed', base))).toEqual({
        userId: 'cust-1',
        reservationId: 'res-1',
        restaurantId: 'rest-1',
        type: 'RESERVATION_CONFIRMED',
        title: 'Reserva confirmada',
        body: 'Tu mesa en La Parrilla para 4 personas el sábado 31 de octubre a las 21:30 está confirmada.',
      });
    });

    it('una persona va en singular', () => {
      const draft = buildNotification(envelope('reservation.confirmed', { ...base, partySize: 1 }));
      expect(draft?.body).toContain('para 1 persona el');
    });

    it('un evento viejo, sin nombre ni fecha, igual genera un mensaje razonable', () => {
      const draft = buildNotification(
        envelope('reservation.confirmed', { reservationId: 'res-1', customerId: 'cust-1', restaurantId: 'rest-1' }),
      );
      expect(draft?.body).toBe('Tu mesa en el restaurante está confirmada.');
    });

    it('un nombre de restaurante vacío se trata como ausente', () => {
      const draft = buildNotification(envelope('reservation.confirmed', { ...base, restaurantName: '  ' }));
      expect(draft?.body).toContain('Tu mesa en el restaurante');
    });
  });

  describe('reservation.cancelled', () => {
    it('si cancela el restaurante con seña, avisa que se devuelve', () => {
      const draft = buildNotification(
        envelope('reservation.cancelled', { ...base, reason: 'CANCELLED_BY_OWNER', refundable: true, depositCents: 20000 }),
      );
      expect(draft).toMatchObject({
        type: 'RESERVATION_CANCELLED_BY_RESTAURANT',
        title: 'El restaurante canceló tu reserva',
        body: 'La Parrilla canceló tu reserva para el sábado 31 de octubre a las 21:30. La seña se te devuelve.',
      });
    });

    it('si cancela el restaurante sin seña, no habla de devoluciones', () => {
      const draft = buildNotification(
        envelope('reservation.cancelled', { ...base, reason: 'CANCELLED_BY_OWNER', refundable: true, depositCents: 0 }),
      );
      expect(draft?.body).not.toMatch(/seña/);
    });

    it('si no es reembolsable lo dice en vez de prometer la devolución', () => {
      const draft = buildNotification(
        envelope('reservation.cancelled', { ...base, reason: 'CANCELLED_BY_OWNER', refundable: false, depositCents: 20000 }),
      );
      expect(draft?.body).toContain('La seña no se devuelve.');
    });

    it('el nombre sin restaurante arranca con mayúscula ("El restaurante canceló…")', () => {
      const draft = buildNotification(
        envelope('reservation.cancelled', { ...base, restaurantName: undefined, reason: 'CANCELLED_BY_OWNER' }),
      );
      expect(draft?.body.startsWith('El restaurante canceló')).toBe(true);
    });

    it('si el cobro falló, explica que se canceló y se puede reservar de nuevo', () => {
      const draft = buildNotification(envelope('reservation.cancelled', { ...base, reason: 'PAYMENT_FAILED', refundable: false }));
      expect(draft).toMatchObject({ type: 'RESERVATION_PAYMENT_FAILED', title: 'No se pudo cobrar la seña' });
      expect(draft?.body).toContain('La Parrilla');
      expect(draft?.body).toContain('Podés intentar reservar de nuevo');
    });

    it('si canceló el propio cliente NO se le avisa (devuelve null)', () => {
      expect(buildNotification(envelope('reservation.cancelled', { ...base, reason: 'CANCELLED_BY_CUSTOMER' }))).toBeNull();
    });

    it('una razón desconocida tampoco genera aviso: mejor callar que decir algo equivocado', () => {
      expect(buildNotification(envelope('reservation.cancelled', { ...base, reason: 'OTRA_COSA' }))).toBeNull();
    });
  });

  describe('reservation.expired', () => {
    it('avisa que venció por no pagar la seña', () => {
      expect(buildNotification(envelope('reservation.expired', base))).toMatchObject({
        type: 'RESERVATION_EXPIRED',
        title: 'Tu reserva venció',
        body: 'No se pagó la seña a tiempo, así que la mesa en La Parrilla para el sábado 31 de octubre a las 21:30 se liberó. Podés reservar de nuevo cuando quieras.',
      });
    });
  });

  describe('eventos que no sirven', () => {
    it.each([
      ['sin customerId', { ...base, customerId: undefined }],
      ['con customerId vacío', { ...base, customerId: '' }],
      ['sin reservationId', { ...base, reservationId: undefined }],
    ])('un evento %s va a la DLQ (PoisonMessageError): reintentarlo no lo arregla', (_label, data) => {
      expect(() => buildNotification(envelope('reservation.confirmed', data))).toThrow(PoisonMessageError);
    });

    it('un tipo de evento que no escuchamos también es venenoso', () => {
      expect(() => buildNotification(envelope('payment.succeeded', base))).toThrow(PoisonMessageError);
    });
  });
});
