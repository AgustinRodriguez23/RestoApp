import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OwnerReservation, User } from '../api/types';
import { dateInputValue } from '../lib/format';
import { mockApi, renderApp, signIn, USER } from '../test/harness';

const OWNER: User = { id: 'o1', email: 'dueno@example.com', name: 'Don Pepe', role: 'RESTAURANT_OWNER' };
const RID = '64b7f0c2a1b2c3d4e5f60718';
const RID2 = '64b7f0c2a1b2c3d4e5f60719';
const restaurant = (id: string, name: string) => ({ id, name, cuisine: 'Parrilla', address: 'Av. 1', openingHours: [], tables: [] });
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const owned = (overrides: Partial<OwnerReservation> = {}): OwnerReservation => ({
  id: '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10',
  restaurantId: RID,
  tableNumber: 2,
  customerName: 'Ana Pérez',
  partySize: 3,
  startsAt: hoursFromNow(-1),
  endsAt: hoursFromNow(0.5),
  status: 'CONFIRMED',
  depositCents: 0,
  notes: null,
  ...overrides,
});
const page = (data: OwnerReservation[], extra = {}) => ({ data, page: 1, limit: 20, total: data.length, totalPages: 1, ...extra });
const LIST = `GET /owner/restaurants/${RID}/reservations`;

describe('OwnerPage', () => {
  it('un cliente no ve el link del panel y si entra a /panel vuelve al inicio', async () => {
    mockApi({ 'GET /restaurants': { body: page([]) } });
    signIn(USER);
    renderApp('/panel');

    await waitFor(() => expect(screen.getByRole('link', { name: 'Mis reservas' })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Panel del local' })).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Panel del local' })).not.toBeInTheDocument();
  });

  it('el dueño ve el link y la lista del día con el nombre del cliente', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [restaurant(RID, 'La Esquina')] },
      [LIST]: { body: page([owned(), owned({ id: 'b', customerName: null, status: 'COMPLETED' })]) },
    });
    signIn(OWNER);
    renderApp('/panel');

    expect(await screen.findByText('Ana Pérez')).toBeInTheDocument();
    expect(screen.getByText('Cliente')).toBeInTheDocument(); // reserva vieja sin nombre
    expect(screen.getByRole('link', { name: 'Panel del local' })).toBeInTheDocument();
    expect(screen.getAllByText('Asistió')).toHaveLength(2); // el botón de la confirmada y la etiqueta de la completada
    // por defecto pide el día de hoy, 20 por página
    expect(server.callsTo('GET', `/owner/restaurants/${RID}/reservations`)[0]?.query).toMatchObject({ date: dateInputValue(), limit: '20', page: '1' });
  });

  it('sin restaurantes explica que no hay nada que mostrar', async () => {
    mockApi({ 'GET /owner/restaurants': { body: [] } });
    signIn(OWNER);
    renderApp('/panel');

    expect(await screen.findByText('Todavía no tenés ningún restaurante')).toBeInTheDocument();
  });

  it('filtrar por estado y cambiar de restaurante vuelve a pedir la lista', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [restaurant(RID, 'La Esquina'), restaurant(RID2, 'El Puerto')] },
      [LIST]: { body: page([owned()]) },
      [`GET /owner/restaurants/${RID2}/reservations`]: { body: page([]) },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel');
    await screen.findByText('Ana Pérez');

    await user.click(screen.getByRole('button', { name: 'No vinieron' }));
    await waitFor(() => expect(server.callsTo('GET', `/owner/restaurants/${RID}/reservations`).some((c) => c.query.status === 'NO_SHOW')).toBe(true));

    await user.selectOptions(screen.getByLabelText('Restaurante'), RID2);
    expect(await screen.findByText('No hay reservas con ese estado ese día')).toBeInTheDocument();
  });

  it('una reserva que ya empezó se marca "No vino" y la lista se refresca', async () => {
    let status: OwnerReservation['status'] = 'CONFIRMED';
    const server = mockApi({
      'GET /owner/restaurants': { body: [restaurant(RID, 'La Esquina')] },
      [LIST]: () => ({ body: page([owned({ status })]) }),
      'PATCH /owner/reservations/3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10/status': () => {
        status = 'NO_SHOW';
        return { body: owned({ status }) };
      },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel');

    await user.click(await screen.findByRole('button', { name: 'No vino' }));

    expect(await screen.findByText('Marcada como no vino')).toBeInTheDocument();
    expect(server.callsTo('PATCH', '/owner/reservations/3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10/status')[0]?.body).toEqual({ status: 'NO_SHOW' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'No vino' })).not.toBeInTheDocument());
  });

  it('una reserva futura no ofrece asistió/no vino: solo cancelar, con confirmación', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [restaurant(RID, 'La Esquina')] },
      [LIST]: { body: page([owned({ startsAt: hoursFromNow(5), endsAt: hoursFromNow(6.5) })]) },
      'POST /reservations/3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10/cancel': { body: owned({ status: 'CANCELLED' }) },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel');

    await screen.findByText('Ana Pérez');
    expect(screen.queryByRole('button', { name: 'Asistió' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText(/¿Cancelar la reserva de Ana Pérez\?/)).toBeInTheDocument();
    expect(server.callsTo('POST', '/reservations/3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10/cancel')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Sí, cancelar' }));
    expect(await screen.findByText('Reserva cancelada')).toBeInTheDocument();
  });

  it('muestra el error del servidor si no se pudo actualizar', async () => {
    mockApi({
      'GET /owner/restaurants': { body: [restaurant(RID, 'La Esquina')] },
      [LIST]: { body: page([owned()]) },
      'PATCH /owner/reservations/3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10/status': { status: 400, body: { message: 'Solo se puede marcar una reserva que ya comenzó' } },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel');

    await user.click(await screen.findByRole('button', { name: 'Asistió' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/ya comenzó/)).toBeInTheDocument();
  });

  it('pagina cuando hay más de una página', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [restaurant(RID, 'La Esquina')] },
      [LIST]: (call) => ({ body: page([owned()], { page: Number(call.query.page), totalPages: 2, total: 21 }) }),
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel');

    await user.click(await screen.findByRole('button', { name: 'Siguiente' }));

    await waitFor(() => expect(server.callsTo('GET', `/owner/restaurants/${RID}/reservations`).some((c) => c.query.page === '2')).toBe(true));
  });
});
