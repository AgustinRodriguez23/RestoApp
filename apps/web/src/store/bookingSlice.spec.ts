import { describe, expect, it } from 'vitest';
import reducer, { bookingActions } from './bookingSlice';

const start = reducer(undefined, bookingActions.openRestaurant({ restaurantId: 'r1', defaultDate: '2026-10-16' }));

describe('bookingSlice', () => {
  it('al abrir un restaurante toma el día por defecto', () => {
    expect(start).toMatchObject({ restaurantId: 'r1', date: '2026-10-16', partySize: 2, startsAt: null });
  });

  it('cambiar personas o día descarta el horario elegido (los libres cambian)', () => {
    const chosen = reducer(start, bookingActions.selectSlot('2026-10-17T00:00:00Z'));
    expect(reducer(chosen, bookingActions.setPartySize(4)).startsAt).toBeNull();
    expect(reducer(chosen, bookingActions.setDate('2026-10-20')).startsAt).toBeNull();
  });

  it('volver al mismo restaurante conserva el borrador (por ejemplo, tras iniciar sesión)', () => {
    let state = reducer(start, bookingActions.selectSlot('2026-10-17T00:00:00Z'));
    state = reducer(state, bookingActions.setNotes('cumpleaños'));
    state = reducer(state, bookingActions.openRestaurant({ restaurantId: 'r1', defaultDate: '2030-01-01' }));
    expect(state).toMatchObject({ startsAt: '2026-10-17T00:00:00Z', notes: 'cumpleaños', date: '2026-10-16' });
  });

  it('abrir otro restaurante descarta horario y notas, pero conserva personas y día', () => {
    let state = reducer(start, bookingActions.setPartySize(5));
    state = reducer(state, bookingActions.selectSlot('2026-10-17T00:00:00Z'));
    state = reducer(state, bookingActions.setNotes('x'));
    state = reducer(state, bookingActions.openRestaurant({ restaurantId: 'r2', defaultDate: '2030-01-01' }));
    expect(state).toMatchObject({ restaurantId: 'r2', partySize: 5, date: '2026-10-16', startsAt: null, notes: '' });
  });
});
