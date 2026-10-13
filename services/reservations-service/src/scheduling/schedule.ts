/** Un turno de atención de un restaurante (viene de restaurants-service). */
export interface Shift {
  dayOfWeek: number; // 0 = domingo ... 6 = sábado
  opens: string; // "HH:mm"
  closes: string; // "HH:mm". Si es menor o igual que opens, cierra al día siguiente.
}

const MINUTES_PER_DAY = 1440;

export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Apertura y cierre en minutos desde la medianoche del día del turno. El cierre puede pasar de 1440. */
function shiftRange(shift: Shift): { opens: number; closes: number } {
  const opens = toMinutes(shift.opens);
  let closes = toMinutes(shift.closes);
  if (closes <= opens) closes += MINUTES_PER_DAY;
  return { opens, closes };
}

/**
 * ¿Una reserva que empieza a `minutesOfDay` (hora local) de ese día de la semana y dura
 * `durationMinutes` entra completa dentro de algún turno?
 *
 * Una reserva a las 00:30 del sábado pertenece al turno del viernes que cierra a la 01:00,
 * por eso también se miran los turnos del día anterior que cruzan la medianoche.
 */
export function fitsInShift(
  shifts: Shift[],
  dayOfWeek: number,
  minutesOfDay: number,
  durationMinutes: number,
): boolean {
  const previousDay = (dayOfWeek + 6) % 7;

  return shifts.some((shift) => {
    const { opens, closes } = shiftRange(shift);

    if (shift.dayOfWeek === dayOfWeek) {
      return minutesOfDay >= opens && minutesOfDay + durationMinutes <= closes;
    }
    if (shift.dayOfWeek === previousDay && closes > MINUTES_PER_DAY) {
      const shifted = minutesOfDay + MINUTES_PER_DAY;
      return shifted >= opens && shifted + durationMinutes <= closes;
    }
    return false;
  });
}

/**
 * Horas de inicio posibles (en minutos desde la medianoche de ese día) para los turnos
 * que abren ese día de la semana. Van alineadas a la grilla (múltiplos de `stepMinutes`)
 * y la reserva completa tiene que terminar antes del cierre. Pueden superar 1440
 * (ej: 1410 = 23:30, 1470 = 00:30 del día siguiente).
 */
export function generateSlotStarts(
  shifts: Shift[],
  dayOfWeek: number,
  durationMinutes: number,
  stepMinutes: number,
): number[] {
  const starts = new Set<number>();

  for (const shift of shifts) {
    if (shift.dayOfWeek !== dayOfWeek) continue;
    const { opens, closes } = shiftRange(shift);
    const firstOnGrid = Math.ceil(opens / stepMinutes) * stepMinutes;
    for (let start = firstOnGrid; start + durationMinutes <= closes; start += stepMinutes) {
      starts.add(start);
    }
  }

  return Array.from(starts).sort((a, b) => a - b);
}
