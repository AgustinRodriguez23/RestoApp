import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertValidTimeZone } from '../scheduling/time-zone';

function positiveInt(config: ConfigService, name: string, fallback: number): number {
  const raw = config.get<string | number>(name);
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} tiene que ser un entero positivo (valor recibido: "${raw}")`);
  }
  return value;
}

/** Reglas de negocio configurables de las reservas. Si algo está mal configurado, el servicio no arranca. */
@Injectable()
export class BookingPolicy {
  /** Cuánto dura cada reserva. */
  readonly durationMinutes: number;
  /** Las reservas empiezan en múltiplos de este valor (30 → 20:00, 20:30, 21:00...). */
  readonly slotStepMinutes: number;
  /** Con cuántos días de anticipación como máximo se puede reservar. */
  readonly maxAdvanceDays: number;
  /** Zona horaria en la que se interpretan los horarios de los restaurantes. */
  readonly timeZone: string;

  constructor(config: ConfigService) {
    this.durationMinutes = positiveInt(config, 'RESERVATION_DURATION_MINUTES', 90);
    this.slotStepMinutes = positiveInt(config, 'RESERVATION_SLOT_STEP_MINUTES', 30);
    this.maxAdvanceDays = positiveInt(config, 'RESERVATION_MAX_ADVANCE_DAYS', 90);
    this.timeZone = config.get<string>('RESTAURANT_TIME_ZONE') || 'America/Argentina/Buenos_Aires';
    assertValidTimeZone(this.timeZone);
  }
}
