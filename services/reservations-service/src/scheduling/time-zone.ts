/**
 * Conversión entre instantes (UTC) y hora local de una zona horaria, usando solo Intl
 * (sin librerías externas). Los horarios de los restaurantes son "20:00" a secas, sin zona:
 * hace falta saber en qué zona se interpretan para convertirlos a instantes reales.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Falla con un mensaje claro si la zona no existe (se usa al arrancar el servicio). */
export function assertValidTimeZone(timeZone: string): void {
  try {
    getFormatter(timeZone);
  } catch {
    throw new Error(`Zona horaria inválida: "${timeZone}". Ejemplo: America/Argentina/Buenos_Aires`);
  }
}

export interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  minutesOfDay: number; // 0-1439
  dayOfWeek: number; // 0 = domingo ... 6 = sábado
}

/** Qué hora es en `timeZone` en el instante dado. */
export function utcToLocal(instant: Date, timeZone: string): LocalTime {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const hour = Number(value('hour')) % 24; // algunos motores devuelven "24" a medianoche
  const minute = Number(value('minute'));
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour,
    minute,
    second: Number(value('second')),
    minutesOfDay: hour * 60 + minute,
    dayOfWeek: WEEKDAYS.indexOf(value('weekday')),
  };
}

/** Diferencia (en ms) entre la hora local de la zona y UTC en ese instante. Negativa al oeste de Greenwich. */
function offsetMs(instant: Date, timeZone: string): number {
  const local = utcToLocal(instant, timeZone);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return localAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * El instante real que corresponde a "ese día, a esos minutos desde la medianoche local".
 * `minutesOfDay` puede superar 1439: 1500 es la 01:00 del día siguiente (turnos que cruzan la medianoche).
 * Se calcula el offset dos veces para acertar también cerca de un cambio de horario de verano.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const firstGuess = naive - offsetMs(new Date(naive), timeZone);
  return new Date(naive - offsetMs(new Date(firstGuess), timeZone));
}

export interface DateOnly {
  year: number;
  month: number;
  day: number;
}

/** Interpreta "YYYY-MM-DD". Devuelve null si el formato es inválido o la fecha no existe (ej: 2026-02-30). */
export function parseDateOnly(text: string): DateOnly | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  return isRealDate ? { year, month, day } : null;
}

/** Día de la semana de una fecha de calendario (0 = domingo ... 6 = sábado). No depende de la zona. */
export function dayOfWeekOf({ year, month, day }: DateOnly): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
