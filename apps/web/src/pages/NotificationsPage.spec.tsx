import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AppNotification, NotificationsPage } from '../api/types';
import { mockApi, renderApp, signIn } from '../test/harness';

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: '64b7f0c2a1b2c3d4e5f60001',
    type: 'RESERVATION_CONFIRMED',
    title: 'Reserva confirmada',
    body: 'Tu mesa en La Esquina de Don Pepe está confirmada.',
    reservationId: 'r1',
    restaurantId: 'rest1',
    read: false,
    readAt: null,
    createdAt: '2026-10-17T20:30:00.000Z',
    ...overrides,
  };
}

function page(data: AppNotification[], unreadCount: number, extra: Partial<NotificationsPage> = {}): NotificationsPage {
  return { data, page: 1, limit: 20, total: data.length, totalPages: 1, unreadCount, ...extra };
}

describe('Campanita', () => {
  it('muestra cuántas notificaciones hay sin leer y lleva a la bandeja', async () => {
    mockApi({
      'GET /notifications/unread-count': { body: { count: 3 } },
      'GET /restaurants': { body: { data: [], page: 1, limit: 9, total: 0, totalPages: 0 } },
    });
    signIn();
    renderApp('/');
    const bell = await screen.findByRole('link', { name: 'Notificaciones, 3 sin leer' });
    expect(bell).toHaveAttribute('href', '/notificaciones');
  });

  it('no consulta nada si no hay sesión', async () => {
    const server = mockApi({ 'GET /restaurants': { body: { data: [], page: 1, limit: 9, total: 0, totalPages: 0 } } });
    renderApp('/');
    await screen.findByRole('link', { name: 'Ingresar' });
    expect(screen.queryByRole('link', { name: /Notificaciones/ })).not.toBeInTheDocument();
    expect(server.callsTo('GET', '/notifications/unread-count')).toHaveLength(0);
  });
});

describe('NotificationsPage', () => {
  it('lista las notificaciones y distingue las sin leer', async () => {
    mockApi({
      'GET /notifications/unread-count': { body: { count: 1 } },
      'GET /notifications': { body: page([notification(), notification({ id: '64b7f0c2a1b2c3d4e5f60002', title: 'Reserva vencida', read: true })], 1) },
    });
    signIn();
    renderApp('/notificaciones');
    expect(await screen.findByRole('heading', { name: /Reserva confirmada/ })).toHaveTextContent('Sin leer');
    expect(screen.getByRole('heading', { name: /Reserva vencida/ })).not.toHaveTextContent('Sin leer');
  });

  it('marca una como leída y refresca la lista', async () => {
    let read = false;
    const server = mockApi({
      'GET /notifications/unread-count': () => ({ body: { count: read ? 0 : 1 } }),
      'GET /notifications': () => ({ body: page([notification({ read })], read ? 0 : 1) }),
      'PATCH /notifications/64b7f0c2a1b2c3d4e5f60001/read': () => {
        read = true;
        return { body: notification({ read: true }) };
      },
    });
    signIn();
    const user = userEvent.setup();
    renderApp('/notificaciones');
    await user.click(await screen.findByRole('button', { name: 'Marcar como leída' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Marcar como leída' })).not.toBeInTheDocument());
    expect(server.callsTo('PATCH', '/notifications/64b7f0c2a1b2c3d4e5f60001/read')).toHaveLength(1);
    expect(await screen.findByRole('link', { name: 'Notificaciones' })).toBeInTheDocument();
  });

  it('marca todas como leídas', async () => {
    let unread = 2;
    const server = mockApi({
      'GET /notifications/unread-count': () => ({ body: { count: unread } }),
      'GET /notifications': () => ({ body: page([notification({ read: unread === 0 })], unread) }),
      'POST /notifications/read-all': () => {
        unread = 0;
        return { body: { updated: 2 } };
      },
    });
    signIn();
    const user = userEvent.setup();
    renderApp('/notificaciones');
    await user.click(await screen.findByRole('button', { name: 'Marcar todas como leídas' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeDisabled());
    expect(server.callsTo('POST', '/notifications/read-all')).toHaveLength(1);
  });

  it('el filtro "Sin leer" pide solo las no leídas', async () => {
    const server = mockApi({
      'GET /notifications/unread-count': { body: { count: 1 } },
      'GET /notifications': (call) => ({ body: page(call.query.unread === 'true' ? [] : [notification()], 1) }),
    });
    signIn();
    const user = userEvent.setup();
    renderApp('/notificaciones');
    await screen.findByRole('heading', { name: /Reserva confirmada/ });
    await user.click(screen.getByRole('button', { name: 'Sin leer' }));
    expect(await screen.findByText('No tenés notificaciones sin leer')).toBeInTheDocument();
    expect(server.callsTo('GET', '/notifications').some((c) => c.query.unread === 'true')).toBe(true);
  });

  it('muestra el estado vacío y el error con reintento', async () => {
    mockApi({
      'GET /notifications/unread-count': { body: { count: 0 } },
      'GET /notifications': { status: 503, body: { message: 'El servicio de notificaciones no está disponible' } },
    });
    signIn();
    renderApp('/notificaciones');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/no está disponible/)).toBeInTheDocument();
  });

  it('pide sesión', async () => {
    mockApi({});
    renderApp('/notificaciones');
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });
});
