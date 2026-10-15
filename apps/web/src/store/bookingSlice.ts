import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Borrador de la reserva que se está armando (personas, día, horario elegido, notas).
 *
 * Por qué Redux y no estado local: el borrador tiene que sobrevivir a la navegación. Si alguien elige
 * un horario sin sesión iniciada, va al login y vuelve, la pantalla del restaurante se vuelve a montar:
 * con useState se perdería todo. Es estado del cliente (no existe en ningún servidor), así que no es
 * trabajo de React Query.
 */
export interface BookingDraft {
  restaurantId: string | null;
  partySize: number;
  date: string;
  startsAt: string | null;
  notes: string;
}

const initialState: BookingDraft = { restaurantId: null, partySize: 2, date: '', startsAt: null, notes: '' };

const bookingSlice = createSlice({
  name: 'booking',
  initialState,
  reducers: {
    /** Al abrir otro restaurante se empieza de cero (conservando personas y día, que suelen repetirse). */
    openRestaurant(state, action: PayloadAction<{ restaurantId: string; defaultDate: string }>) {
      if (state.restaurantId !== action.payload.restaurantId) {
        state.restaurantId = action.payload.restaurantId;
        state.startsAt = null;
        state.notes = '';
      }
      if (!state.date) state.date = action.payload.defaultDate;
    },
    setPartySize(state, action: PayloadAction<number>) {
      state.partySize = action.payload;
      state.startsAt = null; // los horarios libres dependen de cuántos son
    },
    setDate(state, action: PayloadAction<string>) {
      state.date = action.payload;
      state.startsAt = null;
    },
    selectSlot(state, action: PayloadAction<string | null>) {
      state.startsAt = action.payload;
    },
    setNotes(state, action: PayloadAction<string>) {
      state.notes = action.payload;
    },
    /** Después de reservar, el horario ya no es una intención sino una reserva real. */
    clearSelection(state) {
      state.startsAt = null;
      state.notes = '';
    },
  },
});

export const bookingActions = bookingSlice.actions;
export default bookingSlice.reducer;
