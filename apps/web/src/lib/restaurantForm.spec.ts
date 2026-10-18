import { describe, expect, it } from 'vitest';
import { emptyForm, repeatFirstShift, toInput, validate, type RestaurantFormState } from './restaurantForm';

const valid = (): RestaurantFormState => ({ ...emptyForm(), name: 'La Parrilla', cuisine: 'Parrilla', address: 'Av. Mitre 1234' });

describe('validate', () => {
  it('acepta un formulario completo', () => {
    expect(validate(valid())).toEqual({});
  });

  it('pide nombre, cocina y dirección con el largo mínimo del servidor', () => {
    expect(Object.keys(validate({ ...valid(), name: ' a ', cuisine: '', address: 'Av 1' }))).toEqual(['name', 'cuisine', 'address']);
  });

  it('el teléfono es opcional pero, si está, tiene que ser válido', () => {
    expect(validate({ ...valid(), phone: '' })).toEqual({});
    expect(validate({ ...valid(), phone: '+54 11 4444-5555' })).toEqual({});
    expect(validate({ ...valid(), phone: 'llamame' }).phone).toBeDefined();
  });

  it('detecta mesas repetidas, vacías o con capacidad fuera de rango', () => {
    const tables = (t: RestaurantFormState['tables']) => validate({ ...valid(), tables: t }).tables;
    expect(tables([{ number: '1', capacity: '4' }, { number: '1', capacity: '2' }])).toMatch(/repetidos/);
    expect(tables([])).toMatch(/al menos una/);
    expect(tables([{ number: '', capacity: '4' }])).toMatch(/número entero/);
    expect(tables([{ number: '1', capacity: '51' }])).toMatch(/1 a 50/);
    expect(tables([{ number: '1', capacity: '2.5' }])).toMatch(/1 a 50/);
  });

  it('un turno no puede abrir y cerrar a la misma hora; cerrar más temprano es válido (pasa la medianoche)', () => {
    const hours = (opens: string, closes: string) => validate({ ...valid(), hours: [{ dayOfWeek: '5', opens, closes }] }).hours;
    expect(hours('20:00', '20:00')).toMatch(/misma hora/);
    expect(hours('', '23:00')).toMatch(/Completá/);
    expect(hours('20:00', '01:00')).toBeUndefined();
  });
});

describe('toInput', () => {
  it('convierte los textos a números y recorta espacios', () => {
    const input = toInput({ ...valid(), name: '  La Parrilla ', tables: [{ number: '2', capacity: '6' }], hours: [{ dayOfWeek: '0', opens: '12:00', closes: '16:00' }] });
    expect(input).toMatchObject({ name: 'La Parrilla', tables: [{ number: 2, capacity: 6 }], openingHours: [{ dayOfWeek: 0, opens: '12:00', closes: '16:00' }] });
  });

  it('no manda el teléfono si está vacío (el servidor lo rechazaría)', () => {
    expect(toInput({ ...valid(), phone: '  ' })).not.toHaveProperty('phone');
    expect(toInput({ ...valid(), phone: '+54 11 4444-5555' }).phone).toBe('+54 11 4444-5555');
  });
});

describe('repeatFirstShift', () => {
  it('copia el primer turno a los siete días', () => {
    const result = repeatFirstShift([{ dayOfWeek: '5', opens: '12:00', closes: '23:30' }]);
    expect(result).toHaveLength(7);
    expect(result.map((h) => h.dayOfWeek)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(result.every((h) => h.opens === '12:00' && h.closes === '23:30')).toBe(true);
  });

  it('sin turnos no inventa ninguno', () => {
    expect(repeatFirstShift([])).toEqual([]);
  });
});
