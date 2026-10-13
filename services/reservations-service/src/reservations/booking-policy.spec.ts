import { ConfigService } from '@nestjs/config';
import { BookingPolicy } from './booking-policy';

const configWith = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('BookingPolicy', () => {
  it('usa valores por defecto razonables', () => {
    const policy = new BookingPolicy(configWith({}));

    expect(policy).toMatchObject({
      durationMinutes: 90,
      slotStepMinutes: 30,
      maxAdvanceDays: 90,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
  });

  it('toma los valores de las variables de entorno (llegan como texto)', () => {
    const policy = new BookingPolicy(
      configWith({
        RESERVATION_DURATION_MINUTES: '120',
        RESERVATION_SLOT_STEP_MINUTES: '15',
        RESERVATION_MAX_ADVANCE_DAYS: '30',
        RESTAURANT_TIME_ZONE: 'America/New_York',
      }),
    );

    expect(policy).toMatchObject({
      durationMinutes: 120,
      slotStepMinutes: 15,
      maxAdvanceDays: 30,
      timeZone: 'America/New_York',
    });
  });

  it('una variable vacía (como deja docker compose a las no definidas) usa el valor por defecto', () => {
    const policy = new BookingPolicy(configWith({ RESERVATION_DURATION_MINUTES: '', RESTAURANT_TIME_ZONE: '' }));

    expect(policy.durationMinutes).toBe(90);
    expect(policy.timeZone).toBe('America/Argentina/Buenos_Aires');
  });

  it.each(['abc', '0', '-5', '1.5'])('no arranca si la duración es "%s"', (bad) => {
    expect(() => new BookingPolicy(configWith({ RESERVATION_DURATION_MINUTES: bad }))).toThrow(
      /RESERVATION_DURATION_MINUTES/,
    );
  });

  it('no arranca con una zona horaria inexistente', () => {
    expect(() => new BookingPolicy(configWith({ RESTAURANT_TIME_ZONE: 'Atlantida/Capital' }))).toThrow(
      /Zona horaria inválida/,
    );
  });
});
