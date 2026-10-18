const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

/**
 * Los montos viajan en centavos (enteros) para no arrastrar errores de coma flotante.
 * Los centavos se muestran solo si existen: $ 4.500 y $ 4.500,50 (redondear un precio con centavos engaña al cliente).
 */
export function formatMoney(cents: number, currency = 'ARS'): string {
  const digits = cents % 100 === 0 ? 0 : 2; // $ 4.500 o $ 4.500,50, nunca $ 4.500,5
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

export function formatTime(iso: string, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));
}

export function formatDay(iso: string, timeZone = DEFAULT_TZ): string {
  const text = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(new Date(iso));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Fecha de hoy (o de hoy + N días) como YYYY-MM-DD en la zona del restaurante, para el input de fecha. */
export function dateInputValue(offsetDays = 0, now = new Date(), timeZone = DEFAULT_TZ): string {
  const shifted = new Date(now.getTime() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(shifted);
  return parts; // en-CA ya da YYYY-MM-DD
}

/** "12:34" o "4 min" que faltan para una fecha límite; null si ya pasó. */
export function remaining(iso: string, now = Date.now()): string | null {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Clave de idempotencia: randomUUID solo existe en contextos seguros (https/localhost), por eso el plan B. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const ALLERGENS: Record<string, string> = {
  GLUTEN: 'gluten',
  CRUSTACEANS: 'crustáceos',
  EGGS: 'huevo',
  FISH: 'pescado',
  PEANUTS: 'maní',
  SOY: 'soja',
  MILK: 'lácteos',
  TREE_NUTS: 'frutos secos',
  CELERY: 'apio',
  MUSTARD: 'mostaza',
  SESAME: 'sésamo',
  SULPHITES: 'sulfitos',
  LUPIN: 'altramuz',
  MOLLUSCS: 'moluscos',
};

/** Todos los códigos conocidos, en el orden en que se muestran en los formularios. */
export const ALLERGEN_CODES = Object.keys(ALLERGENS);

/** El servidor manda el código (MILK); la persona tiene que leer "lácteos". Lo que no se conoce se muestra tal cual. */
export function allergenLabel(code: string): string {
  return ALLERGENS[code] ?? code.toLowerCase();
}
