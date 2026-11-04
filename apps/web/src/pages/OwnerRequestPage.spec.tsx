import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OwnerRequest, User } from '../api/types';
import { mockApi, renderApp, signIn, USER } from '../test/harness';

const ADMIN: User = { id: 'a1', email: 'admin@example.com', name: 'Admin', role: 'ADMIN' };
const REQ_ID = '0b6c7d8e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

const request = (overrides: Partial<OwnerRequest> = {}): OwnerRequest => ({
  id: REQ_ID,
  status: 'PENDING',
  restaurantName: 'La Esquina',
  address: 'Av. Corrientes 1234',
  phone: '+54 11 5555-1234',
  message: 'Tenemos 12 mesas.',
  rejectionReason: null,
  createdAt: '2026-11-03T15:00:00.000Z',
  reviewedAt: null,
  ...overrides,
});
const notFound = { status: 404, body: { message: 'Todavía no enviaste una solicitud' } };
const page = (data: OwnerRequest[]) => ({ data, page: 1, limit: 10, total: data.length, totalPages: 1 });

describe('Quiero ser dueño (cliente)', () => {
  it('sin solicitud muestra el formulario, valida antes de mandar y después queda "en revisión"', async () => {
    const server = mockApi({
      'GET /owner-requests/mine': notFound,
      'POST /owner-requests': { status: 201, body: request({ message: null }) },
    });
    signIn(USER);
    const user = userEvent.setup();
    renderApp('/quiero-ser-dueno');

    await user.type(await screen.findByLabelText('Nombre del local'), '  La Esquina ');
    await user.type(screen.getByLabelText('Dirección'), 'Av. Corrientes 1234');
    await user.type(screen.getByLabelText('Teléfono de contacto'), 'llamame');
    await user.click(screen.getByRole('button', { name: 'Enviar solicitud' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Escribí un teléfono');
    expect(server.callsTo('POST', '/owner-requests')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Teléfono de contacto'));
    await user.type(screen.getByLabelText('Teléfono de contacto'), '+54 11 5555-1234');
    await user.click(screen.getByRole('button', { name: 'Enviar solicitud' }));

    expect(await screen.findByRole('heading', { name: 'Tu solicitud está en revisión' })).toBeInTheDocument();
    // Sin espacios de más y sin mensaje vacío
    expect(server.callsTo('POST', '/owner-requests')[0]?.body).toEqual({ restaurantName: 'La Esquina', address: 'Av. Corrientes 1234', phone: '+54 11 5555-1234' });
  });

  it('si ya tiene una pendiente (409) muestra el mensaje del servidor', async () => {
    mockApi({
      'GET /owner-requests/mine': notFound,
      'POST /owner-requests': { status: 409, body: { message: 'Ya tenés una solicitud pendiente' } },
    });
    signIn(USER);
    const user = userEvent.setup();
    renderApp('/quiero-ser-dueno');

    await user.type(await screen.findByLabelText('Nombre del local'), 'La Esquina');
    await user.type(screen.getByLabelText('Dirección'), 'Av. Corrientes 1234');
    await user.type(screen.getByLabelText('Teléfono de contacto'), '1155551234');
    await user.click(screen.getByRole('button', { name: 'Enviar solicitud' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ya tenés una solicitud pendiente');
  });

  it('rechazada: muestra el motivo y el formulario con los datos anteriores para reenviar', async () => {
    mockApi({ 'GET /owner-requests/mine': { body: request({ status: 'REJECTED', rejectionReason: 'No pudimos verificar el local.' }) } });
    signIn(USER);
    renderApp('/quiero-ser-dueno');

    expect(await screen.findByText('Motivo: No pudimos verificar el local.')).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre del local')).toHaveValue('La Esquina');
    expect(screen.getByRole('button', { name: 'Enviar solicitud' })).toBeInTheDocument();
  });

  it('aprobada: pide el token nuevo una sola vez y aparece el panel del local en la navegación', async () => {
    const server = mockApi({
      'GET /owner-requests/mine': { body: request({ status: 'APPROVED' }) },
      'POST /auth/token': { body: { accessToken: 'jwt-de-dueno', user: { ...USER, role: 'RESTAURANT_OWNER' } } },
    });
    signIn(USER);
    renderApp('/quiero-ser-dueno');

    expect(await screen.findByText('Tu cuenta ya es de dueño de restaurante.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Panel del local' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Quiero ser dueño' })).not.toBeInTheDocument();
    expect(server.callsTo('POST', '/auth/token')).toHaveLength(1);
    // Las llamadas siguientes ya van con el token nuevo
    expect(JSON.parse(localStorage.getItem('reservas.session') ?? '{}').token).toBe('jwt-de-dueno');
  });
});

describe('Solicitudes (admin)', () => {
  it('lista las pendientes con quién las envió y aprueba una', async () => {
    let approved = false;
    const server = mockApi({
      'GET /owner-requests': () => ({ body: page(approved ? [] : [request({ applicant: { id: 'u1', name: 'Ana García', email: 'ana@example.com' } })]) }),
      [`POST /owner-requests/${REQ_ID}/approve`]: () => {
        approved = true;
        return { body: request({ status: 'APPROVED' }) };
      },
    });
    signIn(ADMIN);
    const user = userEvent.setup();
    renderApp('/admin/solicitudes');

    const card = (await screen.findByRole('heading', { name: 'La Esquina' })).closest('li')!;
    expect(within(card).getByText('Ana García · ana@example.com')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Aprobar' }));

    expect(await screen.findByText('Ana García ya es dueño de restaurante')).toBeInTheDocument();
    expect(await screen.findByText('No hay solicitudes para revisar')).toBeInTheDocument();
    expect(server.callsTo('GET', '/owner-requests')[0]?.query).toMatchObject({ status: 'PENDING', page: '1' });
  });

  it('rechazar pide un motivo y lo manda', async () => {
    const server = mockApi({
      'GET /owner-requests': { body: page([request()]) },
      [`POST /owner-requests/${REQ_ID}/reject`]: { body: request({ status: 'REJECTED' }) },
    });
    signIn(ADMIN);
    const user = userEvent.setup();
    renderApp('/admin/solicitudes');

    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Contale por qué');
    expect(server.callsTo('POST', `/owner-requests/${REQ_ID}/reject`)).toHaveLength(0);

    await user.type(screen.getByLabelText(/Motivo del rechazo/), 'No pudimos verificar el local.');
    await user.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));

    await waitFor(() => expect(server.callsTo('POST', `/owner-requests/${REQ_ID}/reject`)[0]?.body).toEqual({ reason: 'No pudimos verificar el local.' }));
  });

  it('si otro admin ya la revisó (409) lo avisa', async () => {
    mockApi({
      'GET /owner-requests': { body: page([request()]) },
      [`POST /owner-requests/${REQ_ID}/approve`]: { status: 409, body: { message: 'Esa solicitud ya fue revisada' } },
    });
    signIn(ADMIN);
    const user = userEvent.setup();
    renderApp('/admin/solicitudes');

    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Esa solicitud ya fue revisada');
  });

  it('un cliente no ve el link y si entra a la URL vuelve al inicio', async () => {
    mockApi({ 'GET /restaurants': { body: { data: [], page: 1, limit: 12, total: 0, totalPages: 0 } } });
    signIn(USER);
    renderApp('/admin/solicitudes');

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Solicitudes para ser dueño' })).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Solicitudes' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quiero ser dueño' })).toBeInTheDocument();
  });
});

describe('menú en pantallas chicas', () => {
  it('el botón abre y cierra el menú; Escape y tocar un link lo cierran', async () => {
    mockApi({
      'GET /restaurants': { body: { data: [], page: 1, limit: 12, total: 0, totalPages: 0 } },
      'GET /reservations/mine': { body: { data: [], page: 1, limit: 10, total: 0, totalPages: 0 } },
    });
    signIn(USER);
    const user = userEvent.setup();
    renderApp('/');

    const button = screen.getByRole('button', { name: 'Abrir menú' });
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(nav).toHaveClass('hidden');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAccessibleName('Cerrar menú');
    expect(nav).toHaveClass('flex');

    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(within(nav).getByRole('link', { name: 'Mis reservas' }));
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
