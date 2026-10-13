import { fitsInShift, generateSlotStarts, Shift, toMinutes } from './schedule';

const FRIDAY = 5;
const SATURDAY = 6;
const SUNDAY = 0;
const MONDAY = 1;
const TUESDAY = 2;

const shifts: Shift[] = [
  { dayOfWeek: FRIDAY, opens: '20:00', closes: '01:00' }, // cena que cruza la medianoche
  { dayOfWeek: SATURDAY, opens: '12:00', closes: '16:00' }, // almuerzo
  { dayOfWeek: SATURDAY, opens: '20:00', closes: '02:00' }, // cena que cruza la medianoche
  { dayOfWeek: MONDAY, opens: '09:00', closes: '17:00' }, // turno común
];

const at = (hhmm: string) => toMinutes(hhmm);

describe('toMinutes', () => {
  it('convierte HH:mm a minutos desde la medianoche', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('23:59')).toBe(1439);
  });
});

describe('fitsInShift', () => {
  it('acepta una reserva dentro del turno', () => {
    expect(fitsInShift(shifts, FRIDAY, at('21:00'), 90)).toBe(true);
  });

  it('acepta justo a la apertura y justo terminando al cierre (límites incluidos)', () => {
    expect(fitsInShift(shifts, MONDAY, at('09:00'), 90)).toBe(true);
    expect(fitsInShift(shifts, MONDAY, at('15:30'), 90)).toBe(true); // termina 17:00 en punto
  });

  it('rechaza antes de abrir', () => {
    expect(fitsInShift(shifts, FRIDAY, at('19:30'), 90)).toBe(false);
  });

  it('rechaza si la reserva terminaría después del cierre', () => {
    expect(fitsInShift(shifts, MONDAY, at('16:00'), 90)).toBe(false); // terminaría 17:30
  });

  it('un día sin turnos no admite reservas', () => {
    expect(fitsInShift(shifts, TUESDAY, at('12:00'), 90)).toBe(false);
  });

  it('sin turnos no hay reservas posibles', () => {
    expect(fitsInShift([], FRIDAY, at('21:00'), 90)).toBe(false);
  });

  describe('turnos que cruzan la medianoche', () => {
    it('la cena del viernes puede empezar a las 23:30 y terminar a la 01:00', () => {
      expect(fitsInShift(shifts, FRIDAY, at('23:30'), 90)).toBe(true);
    });

    it('una reserva el sábado a las 00:00 pertenece a la cena del viernes (si entra antes del cierre)', () => {
      expect(fitsInShift(shifts, SATURDAY, at('00:00'), 60)).toBe(true); // 00:00–01:00
      expect(fitsInShift(shifts, SATURDAY, at('00:00'), 90)).toBe(false); // terminaría 01:30, cierra 01:00
    });

    it('la cena del sábado se extiende al domingo hasta las 02:00', () => {
      expect(fitsInShift(shifts, SUNDAY, at('00:30'), 90)).toBe(true); // termina 02:00 en punto
      expect(fitsInShift(shifts, SUNDAY, at('01:00'), 90)).toBe(false);
    });

    it('un turno que NO cruza la medianoche no se extiende al día siguiente', () => {
      expect(fitsInShift(shifts, TUESDAY, at('00:30'), 30)).toBe(false); // el lunes cierra 17:00
    });

    it('el viernes a las 00:30 no es parte de la cena del viernes (esa empieza a las 20:00)', () => {
      // viernes 00:30 pertenecería a un turno del jueves, y no hay ninguno
      expect(fitsInShift(shifts, FRIDAY, at('00:30'), 30)).toBe(false);
    });
  });
});

describe('generateSlotStarts', () => {
  it('genera las horas de inicio de un turno, cada 30 minutos, hasta que la reserva entre completa', () => {
    const starts = generateSlotStarts(shifts, MONDAY, 90, 30); // 09:00–17:00

    expect(starts[0]).toBe(at('09:00'));
    expect(starts[starts.length - 1]).toBe(at('15:30')); // la última que termina a las 17:00
    expect(starts).toHaveLength(14);
  });

  it('en un turno que cruza la medianoche devuelve minutos mayores a 1440', () => {
    const starts = generateSlotStarts(shifts, FRIDAY, 90, 30); // 20:00–01:00

    expect(starts).toEqual([1200, 1230, 1260, 1290, 1320, 1350, 1380, 1410]);
    expect(starts[starts.length - 1] + 90).toBe(1500); // termina a la 01:00 del día siguiente
  });

  it('junta los turnos del día (almuerzo y cena) en orden', () => {
    const starts = generateSlotStarts(shifts, SATURDAY, 90, 30);

    expect(starts).toHaveLength(6 + 10); // almuerzo 12:00–16:00 → 6; cena 20:00–02:00 → 10
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[6]).toBe(at('20:00'));
    expect(starts[starts.length - 1]).toBe(at('24:30')); // 00:30 del domingo, termina 02:00
  });

  it('alinea las horas a la grilla aunque el turno abra a una hora "rara"', () => {
    const odd: Shift[] = [{ dayOfWeek: MONDAY, opens: '20:10', closes: '23:00' }];

    expect(generateSlotStarts(odd, MONDAY, 90, 30)).toEqual([at('20:30'), at('21:00'), at('21:30')]);
  });

  it('si dos turnos del mismo día se superponen no repite horarios', () => {
    const overlapping: Shift[] = [
      { dayOfWeek: MONDAY, opens: '12:00', closes: '15:00' },
      { dayOfWeek: MONDAY, opens: '14:00', closes: '17:00' },
    ];

    const starts = generateSlotStarts(overlapping, MONDAY, 60, 30);

    expect(new Set(starts).size).toBe(starts.length);
    expect(starts).toHaveLength(9); // 12:00 a 16:00 cada 30 min
  });

  it('devuelve vacío si el día no tiene turnos o la reserva no entra en el turno', () => {
    expect(generateSlotStarts(shifts, TUESDAY, 90, 30)).toEqual([]);
    expect(generateSlotStarts([{ dayOfWeek: MONDAY, opens: '10:00', closes: '11:00' }], MONDAY, 90, 30)).toEqual([]);
  });

  it('es coherente con fitsInShift: toda hora generada es aceptada al validarla, también las del día siguiente', () => {
    for (const day of [FRIDAY, SATURDAY, MONDAY]) {
      const starts = generateSlotStarts(shifts, day, 90, 30);
      expect(starts.length).toBeGreaterThan(0);

      for (const start of starts) {
        // 1470 = 00:30 del día siguiente: se valida como "día siguiente, 30 minutos"
        const dayOffset = Math.floor(start / 1440);
        expect(fitsInShift(shifts, (day + dayOffset) % 7, start % 1440, 90)).toBe(true);
      }
    }
  });

  it('...y la hora siguiente a la última generada ya no entra', () => {
    const lastMonday = generateSlotStarts(shifts, MONDAY, 90, 30).at(-1)!;
    const lastFriday = generateSlotStarts(shifts, FRIDAY, 90, 30).at(-1)!;

    expect(fitsInShift(shifts, MONDAY, lastMonday + 30, 90)).toBe(false);
    expect(fitsInShift(shifts, FRIDAY, lastFriday + 30, 90)).toBe(false);
  });
});
