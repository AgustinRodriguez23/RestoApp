import type { MenuItem, MenuItemInput } from '../api/types';

/** Estado del formulario de un plato: todo como texto; los precios se escriben en pesos y viajan en centavos. */
export interface MenuFormState {
  category: string;
  name: string;
  description: string;
  price: string;
  allergens: string[];
  variants: { name: string; delta: string }[];
  available: boolean;
}

export const emptyMenuForm = (category = ''): MenuFormState => ({
  category,
  name: '',
  description: '',
  price: '',
  allergens: [],
  variants: [],
  available: true,
});

const MAX_CENTS = 100_000_000;
const AMOUNT = /^-?\d+([.,]\d{1,2})?$/;

/** "12500,50" o "12500.50" → 1250050. null si no es un monto válido (la coma decimal es lo normal en Argentina). */
export function pesosToCents(text: string): number | null {
  const clean = text.trim();
  if (!AMOUNT.test(clean)) return null;
  return Math.round(Number(clean.replace(',', '.')) * 100);
}

/** 1250050 → "12500.5"; 1250000 → "12500". Lo que se carga en el campo al editar. */
export function centsToPesos(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.?0+$/, '');
}

export function formFromItem(item: MenuItem): MenuFormState {
  return {
    category: item.category,
    name: item.name,
    description: item.description ?? '',
    price: centsToPesos(item.priceCents),
    allergens: [...item.allergens],
    variants: item.variants.map((v) => ({ name: v.name, delta: centsToPesos(v.priceDeltaCents) })),
    available: item.available,
  };
}

export type MenuFormErrors = Partial<Record<'category' | 'name' | 'description' | 'price' | 'variants', string>>;

/** Las mismas reglas que restaurants-service, para avisar al instante. */
export function validateMenu(form: MenuFormState): MenuFormErrors {
  const errors: MenuFormErrors = {};
  const len = (value: string, min: number, max: number) => value.trim().length >= min && value.trim().length <= max;

  if (!len(form.category, 2, 60)) errors.category = 'La categoría tiene que tener entre 2 y 60 caracteres.';
  if (!len(form.name, 2, 100)) errors.name = 'El nombre tiene que tener entre 2 y 100 caracteres.';
  if (form.description.trim().length > 500) errors.description = 'La descripción puede tener hasta 500 caracteres.';

  const price = pesosToCents(form.price);
  if (price === null || price < 0) errors.price = 'Poné un precio válido, por ejemplo 12500 o 12500,50.';
  else if (price > MAX_CENTS) errors.price = 'El precio es demasiado alto.';

  if (form.variants.length > 20) errors.variants = 'Máximo 20 variantes.';
  else if (form.variants.some((v) => v.name.trim().length < 1 || v.name.trim().length > 60)) errors.variants = 'Cada variante necesita un nombre (hasta 60 caracteres).';
  else if (form.variants.some((v) => {
    const delta = pesosToCents(v.delta);
    return delta === null || Math.abs(delta) > MAX_CENTS;
  })) errors.variants = 'La diferencia de precio de cada variante tiene que ser un monto válido (puede ser negativo).';

  return errors;
}

export function toMenuInput(form: MenuFormState): MenuItemInput {
  return {
    category: form.category.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    priceCents: pesosToCents(form.price) ?? 0,
    allergens: form.allergens,
    variants: form.variants.map((v) => ({ name: v.name.trim(), priceDeltaCents: pesosToCents(v.delta) ?? 0 })),
    available: form.available,
  };
}
