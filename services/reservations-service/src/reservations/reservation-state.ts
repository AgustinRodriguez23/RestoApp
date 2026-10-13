import { ConflictException } from '@nestjs/common';
import { ReservationStatus } from './entities/reservation-status.enum';

/**
 * Máquina de estados: desde qué estado se puede pasar a cuál.
 * Todo lo que no figura acá está prohibido (los estados finales no tienen salida).
 */
const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  [ReservationStatus.CONFIRMED]: [
    ReservationStatus.CANCELLED,
    ReservationStatus.COMPLETED,
    ReservationStatus.NO_SHOW,
  ],
  [ReservationStatus.CANCELLED]: [],
  [ReservationStatus.COMPLETED]: [],
  [ReservationStatus.NO_SHOW]: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`No se puede pasar una reserva de ${from} a ${to}`);
  }
}
