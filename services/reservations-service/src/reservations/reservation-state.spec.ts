import { ConflictException } from '@nestjs/common';
import { ReservationStatus } from './entities/reservation-status.enum';
import { assertTransition, canTransition } from './reservation-state';

const { CONFIRMED, CANCELLED, COMPLETED, NO_SHOW } = ReservationStatus;

describe('máquina de estados de la reserva', () => {
  it.each([
    [CONFIRMED, CANCELLED],
    [CONFIRMED, COMPLETED],
    [CONFIRMED, NO_SHOW],
  ])('permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([CANCELLED, COMPLETED, NO_SHOW])('%s es un estado final: no se puede salir de él', (final) => {
    for (const to of Object.values(ReservationStatus)) {
      expect(canTransition(final, to)).toBe(false);
    }
  });

  it('una reserva confirmada no puede "confirmarse" de nuevo', () => {
    expect(canTransition(CONFIRMED, CONFIRMED)).toBe(false);
  });

  it('assertTransition responde 409 con un mensaje que dice de dónde a dónde', () => {
    expect(() => assertTransition(CANCELLED, COMPLETED)).toThrow(ConflictException);
    expect(() => assertTransition(CANCELLED, COMPLETED)).toThrow(/CANCELLED a COMPLETED/);
  });
});
