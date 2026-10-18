import { describe, expect, it } from 'vitest';
import type { MenuItem } from '../api/types';
import { centsToPesos, emptyMenuForm, formFromItem, pesosToCents, toMenuInput, validateMenu, type MenuFormState } from './menuForm';

const valid = (): MenuFormState => ({ ...emptyMenuForm(), category: 'Postres', name: 'Flan casero', price: '4500' });

describe('pesosToCents', () => {
  it('acepta coma o punto decimal y devuelve enteros exactos', () => {
    expect(pesosToCents('12500')).toBe(1250000);
    expect(pesosToCents('12500,50')).toBe(1250050);
    expect(pesosToCents('12500.5')).toBe(1250050);
    expect(pesosToCents('0,10')).toBe(10);
    expect(pesosToCents('19,99')).toBe(1999); // 19.99 * 100 en coma flotante da 1998.9999...: se redondea
    expect(pesosToCents('-150')).toBe(-15000);
  });

  it('rechaza lo que no es un monto', () => {
    for (const bad of ['', 'abc', '12,345', '1.2.3', '$100', '1e3', ' ']) expect(pesosToCents(bad)).toBeNull();
  });
});

describe('centsToPesos', () => {
  it('muestra el monto sin ceros de más y vuelve a ser el mismo número', () => {
    expect(centsToPesos(1250000)).toBe('12500');
    expect(centsToPesos(1250050)).toBe('12500.5');
    expect(centsToPesos(1999)).toBe('19.99');
    expect(centsToPesos(0)).toBe('0');
    expect(centsToPesos(10000)).toBe('100');
    for (const cents of [0, 5, 10, 1999, 10000, 1250050, -15000]) expect(pesosToCents(centsToPesos(cents))).toBe(cents);
  });
});

describe('validateMenu', () => {
  it('acepta un plato completo', () => {
    expect(validateMenu(valid())).toEqual({});
  });

  it('pide categoría, nombre y precio válidos', () => {
    expect(Object.keys(validateMenu({ ...valid(), category: 'a', name: '', price: 'gratis' }))).toEqual(['category', 'name', 'price']);
  });

  it('el precio no puede ser negativo ni pasarse del máximo del servidor', () => {
    expect(validateMenu({ ...valid(), price: '-1' }).price).toBeDefined();
    expect(validateMenu({ ...valid(), price: '1000001' }).price).toMatch(/alto/);
    expect(validateMenu({ ...valid(), price: '0' })).toEqual({}); // un plato gratis es válido
  });

  it('valida las variantes (nombre y diferencia, que puede ser negativa)', () => {
    const variants = (v: MenuFormState['variants']) => validateMenu({ ...valid(), variants: v }).variants;
    expect(variants([{ name: 'Grande', delta: '1500' }])).toBeUndefined();
    expect(variants([{ name: 'Chico', delta: '-500' }])).toBeUndefined();
    expect(variants([{ name: '', delta: '0' }])).toMatch(/nombre/);
    expect(variants([{ name: 'X', delta: 'mucho' }])).toMatch(/monto válido/);
  });
});

describe('toMenuInput / formFromItem', () => {
  const item: MenuItem = {
    id: 'i1',
    category: 'Postres',
    name: 'Flan',
    description: 'Con dulce de leche',
    priceCents: 450050,
    allergens: ['MILK', 'EGGS'],
    variants: [{ name: 'Con crema', priceDeltaCents: -50000 }],
    available: false,
  };

  it('convierte los pesos a centavos y recorta espacios', () => {
    const input = toMenuInput({ ...valid(), name: '  Flan  ', price: '4500,5', variants: [{ name: ' Grande ', delta: '15' }], allergens: ['MILK'] });
    expect(input).toMatchObject({ name: 'Flan', priceCents: 450050, allergens: ['MILK'], variants: [{ name: 'Grande', priceDeltaCents: 1500 }], available: true });
  });

  it('editar y volver a guardar sin tocar nada no cambia el plato', () => {
    expect(toMenuInput(formFromItem(item))).toEqual({
      category: 'Postres',
      name: 'Flan',
      description: 'Con dulce de leche',
      priceCents: 450050,
      allergens: ['MILK', 'EGGS'],
      variants: [{ name: 'Con crema', priceDeltaCents: -50000 }],
      available: false,
    });
  });
});
