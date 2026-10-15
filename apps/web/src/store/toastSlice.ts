import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  text: string;
}

/** Avisos globales ("Reserva cancelada"): los dispara cualquier pantalla y los muestra un único componente. */
const toastSlice = createSlice({
  name: 'toasts',
  initialState: [] as Toast[],
  reducers: {
    push: {
      reducer: (state, action: PayloadAction<Toast>) => {
        state.push(action.payload);
        if (state.length > 4) state.shift();
      },
      prepare: (kind: Toast['kind'], text: string) => ({ payload: { id: nanoid(), kind, text } }),
    },
    dismiss: (state, action: PayloadAction<string>) => state.filter((t) => t.id !== action.payload),
  },
});

export const toastActions = toastSlice.actions;
export default toastSlice.reducer;
