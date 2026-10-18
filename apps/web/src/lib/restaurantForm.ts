import type { Restaurant, RestaurantInput } from '../api/types';

/** Estado del formulario: todo como texto, tal cual lo escribe la persona; se convierte recién al enviar. */
export interface RestaurantFormState {
  name: string;
  cuisine: string;
  address: string;
  phone: string;
  description: string;
  tables: { number: string; capacity: string }[];
  hours: { dayOfWeek: string; opens: string; closes: string }[];
}

export const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export const emptyForm = (): RestaurantFormState => ({
  name: '',
  cuisine: '',
  address: '',
  phone: '',
  description: '',
  tables: [{ number: '1', capacity: '4' }],
  hours: [{ dayOfWeek: '5', opens: '20:00', closes: '23:30' }],
});

export function formFromRestaurant(r: Restaurant): RestaurantFormState {
  return {
    name: r.name,
    cuisine: r.cuisine,
    address: r.address,
    phone: r.phone ?? '',
    description: r.description ?? '',
    tables: r.tables.map((t) => ({ number: String(t.number), capacity: String(t.capacity) })),
    hours: r.openingHours.map((h) => ({ dayOfWeek: String(h.dayOfWeek), opens: h.opens, closes: h.closes })),
  };
}

/** Un turno por cada día de la semana, copiando el primero (el caso más común: "abrimos todos los días igual"). */
export function repeatFirstShift(hours: RestaurantFormState['hours']): RestaurantFormState['hours'] {
  const first = hours[0];
  if (!first) return hours;
  return DAYS.map((_, day) => ({ dayOfWeek: String(day), opens: first.opens, closes: first.closes }));
}

export type FormErrors = Partial<Record<'name' | 'cuisine' | 'address' | 'phone' | 'tables' | 'hours', string>>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE = /^[+\d][\d\s()-]{5,19}$/;

/** Las mismas reglas que el servidor, para avisar al instante. El servidor igual las vuelve a validar. */
export function validate(form: RestaurantFormState): FormErrors {
  const errors: FormErrors = {};
  const len = (value: string, min: number, max: number) => value.trim().length >= min && value.trim().length <= max;

  if (!len(form.name, 2, 100)) errors.name = 'El nombre tiene que tener entre 2 y 100 caracteres.';
  if (!len(form.cuisine, 2, 50)) errors.cuisine = 'La cocina tiene que tener entre 2 y 50 caracteres.';
  if (!len(form.address, 5, 200)) errors.address = 'La dirección tiene que tener entre 5 y 200 caracteres.';
  if (form.phone.trim() && !PHONE.test(form.phone.trim())) errors.phone = 'El teléfono no tiene un formato válido (ej: +54 11 4444-5555).';

  const numbers = form.tables.map((t) => Number(t.number));
  if (form.tables.length === 0) errors.tables = 'Cargá al menos una mesa.';
  else if (form.tables.some((t) => !Number.isInteger(Number(t.number)) || Number(t.number) < 1 || t.number.trim() === ''))
    errors.tables = 'Cada mesa necesita un número entero desde 1.';
  else if (form.tables.some((t) => !Number.isInteger(Number(t.capacity)) || Number(t.capacity) < 1 || Number(t.capacity) > 50 || t.capacity.trim() === ''))
    errors.tables = 'La capacidad de cada mesa va de 1 a 50 personas.';
  else if (new Set(numbers).size !== numbers.length) errors.tables = 'Hay números de mesa repetidos.';

  if (form.hours.some((h) => !TIME.test(h.opens) || !TIME.test(h.closes))) errors.hours = 'Completá la hora de apertura y de cierre de cada turno.';
  else if (form.hours.some((h) => h.opens === h.closes)) errors.hours = 'Un turno no puede abrir y cerrar a la misma hora.';

  return errors;
}

export function toInput(form: RestaurantFormState): RestaurantInput {
  const input: RestaurantInput = {
    name: form.name.trim(),
    cuisine: form.cuisine.trim(),
    address: form.address.trim(),
    description: form.description.trim(),
    tables: form.tables.map((t) => ({ number: Number(t.number), capacity: Number(t.capacity) })),
    openingHours: form.hours.map((h) => ({ dayOfWeek: Number(h.dayOfWeek), opens: h.opens, closes: h.closes })),
  };
  // El servidor rechaza un teléfono vacío (no matchea el formato): si no hay, simplemente no se manda
  if (form.phone.trim()) input.phone = form.phone.trim();
  return input;
}
