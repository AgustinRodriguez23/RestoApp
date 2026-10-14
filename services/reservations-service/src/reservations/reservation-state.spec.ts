import { ConflictException } from '@nestjs/common';
import { ReservationStatus } from './entities/reservation-status.enum';
import { assertTransition, canTransition } from './reservation-state';

const { CONFIRMED, CANCELLED, COMPLETED, NO_SHOW, PENDING_PAYMENT, EXPIRED } = ReservationStatus;

describe('máquina de estados de la reserva', () => {
  it.each([
    [CONFIRMED, CANCELLED],
    [CONFIRMED, COMPLETED],
    [CONFIRMED, NO_SHOW],
    [PENDING_PAYMENT, CONFIRMED],
    [PENDING_PAYMENT, CANCELLED],
    [PENDING_PAYMENT, EXPIRED],
  ])('permite %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([CANCELLED, EXPIRED, COMPLETED, NO_SHOW])('%s es un estado final: no se puede salir de él', (final) => {
    for (const to of Object.values(ReservationStatus)) {
      expect(canTransition(final, to)).toBe(false);
    }
  });

  it('una reserva que espera el pago no puede completarse ni marcarse ausente: primero tiene que confirmarse', () => {
    expect(canTransition(PENDING_PAYMENT, COMPLETED)).toBe(false);
    expect(canTransition(PENDING_PAYMENT, NO_SHOW)).toBe(false);
  });

  it('una reserva confirmada no puede volver a esperar el pago ni vencer', () => {
    expect(canTransition(CONFIRMED, PENDING_PAYMENT)).toBe(false);
    expect(canTransition(CONFIRMED, EXPIRED)).toBe(false);
  });

  it('una reserva confirmada no puede "confirmarse" de nuevo', () => {
    expect(canTransition(CONFIRMED, CONFIRMED)).toBe(false);
  });

  it('assertTransition responde 409 con un mensaje que dice de dónde a dónde', () => {
    expect(() => assertTransition(CANCELLED, COMPLETED)).toThrow(ConflictException);
    expect(() => assertTransition(CANCELLED, COMPLETED)).toThrow(/CANCELLED a COMPLETED/);
  });
});
