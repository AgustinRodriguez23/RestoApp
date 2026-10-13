import {
  assertValidTimeZone,
  dayOfWeekOf,
  localToUtc,
  parseDateOnly,
  utcToLocal,
} from './time-zone';

const BA = 'America/Argentina/Buenos_Aires'; // UTC-3 todo el año
const NY = 'America/New_York'; // con horario de verano

describe('utcToLocal', () => {
  it('convierte un instante a la hora local (Buenos Aires = UTC-3)', () => {
    const local = utcToLocal(new Date('2026-10-16T00:00:00Z'), BA);

    expect(local).toMatchObject({ year: 2026, month: 10, day: 15, hour: 21, minute: 0, minutesOfDay: 1260 });
    expect(local.dayOfWeek).toBe(4); // jueves: en UTC ya es viernes, pero acá todavía es jueves
  });

  it('a medianoche devuelve hora 0 (no 24)', () => {
    const local = utcToLocal(new Date('2026-10-16T03:00:00Z'), BA);

    expect(local).toMatchObject({ day: 16, hour: 0, minutesOfDay: 0, dayOfWeek: 5 });
  });

  it('respeta el horario de verano de la zona', () => {
    expect(utcToLocal(new Date('2026-07-01T16:00:00Z'), NY).hour).toBe(12); // EDT = UTC-4
    expect(utcToLocal(new Date('2026-01-15T17:00:00Z'), NY).hour).toBe(12); // EST = UTC-5
  });
});

describe('localToUtc', () => {
  it('convierte hora local a instante real', () => {
    expect(localToUtc(2026, 10, 16, 20 * 60, BA).toISOString()).toBe('2026-10-16T23:00:00.000Z');
  });

  it('acepta minutos mayores a 1439: son horas del día siguiente (turnos que cruzan la medianoche)', () => {
    // 1500 minutos = 01:00 del día siguiente
    expect(localToUtc(2026, 10, 16, 1500, BA).toISOString()).toBe('2026-10-17T04:00:00.000Z');
  });

  it('usa el offset correcto en verano e invierno', () => {
    expect(localToUtc(2026, 7, 1, 12 * 60, NY).toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(localToUtc(2026, 1, 15, 12 * 60, NY).toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('acierta el día en que cambia el horario (adelanto de hora en Nueva York, 8 de marzo de 2026)', () => {
    expect(localToUtc(2026, 3, 8, 1 * 60, NY).toISOString()).toBe('2026-03-08T06:00:00.000Z'); // 01:00 EST
    expect(localToUtc(2026, 3, 8, 12 * 60, NY).toISOString()).toBe('2026-03-08T16:00:00.000Z'); // 12:00 EDT
  });

  it('acierta el día en que se retrasa la hora (1 de noviembre de 2026)', () => {
    expect(localToUtc(2026, 11, 1, 12 * 60, NY).toISOString()).toBe('2026-11-01T17:00:00.000Z'); // 12:00 EST
  });

  it.each([
    ['2026-03-08T15:30:00Z', NY],
    ['2026-11-01T04:59:00Z', NY],
    ['2026-10-16T23:30:00Z', BA],
    ['2026-12-31T23:59:00Z', BA],
  ])('es la inversa de utcToLocal (%s en %s)', (iso, zone) => {
    const instant = new Date(iso);
    const local = utcToLocal(instant, zone);

    expect(localToUtc(local.year, local.month, local.day, local.minutesOfDay, zone).toISOString()).toBe(
      instant.toISOString(),
    );
  });
});

describe('parseDateOnly', () => {
  it('interpreta una fecha válida', () => {
    expect(parseDateOnly('2026-10-16')).toEqual({ year: 2026, month: 10, day: 16 });
  });

  it('respeta los años bisiestos', () => {
    expect(parseDateOnly('2028-02-29')).not.toBeNull();
    expect(parseDateOnly('2026-02-29')).toBeNull();
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '16/10/2026', '2026-1-1', '', 'hoy'])(
    'rechaza "%s"',
    (text) => {
      expect(parseDateOnly(text)).toBeNull();
    },
  );
});

describe('dayOfWeekOf', () => {
  it('devuelve el día de la semana de una fecha de calendario', () => {
    expect(dayOfWeekOf({ year: 2026, month: 10, day: 16 })).toBe(5); // viernes
    expect(dayOfWeekOf({ year: 2026, month: 10, day: 18 })).toBe(0); // domingo
  });
});

describe('assertValidTimeZone', () => {
  it('acepta una zona real', () => {
    expect(() => assertValidTimeZone(BA)).not.toThrow();
  });

  it('rechaza una zona inexistente con un mensaje claro', () => {
    expect(() => assertValidTimeZone('Marte/Olympus_Mons')).toThrow(/Zona horaria inválida/);
  });
});
