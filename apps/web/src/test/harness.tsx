import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { Payment, Reservation, User } from '../api/types';
import { App } from '../App';
import { AppProviders } from '../providers';
import { createStore } from '../store';

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = Reply | ((call: RecordedCall) => Reply);

/**
 * Reemplaza fetch por un servidor falso: cada ruta ("GET /restaurants") responde lo que se le diga y
 * todos los pedidos quedan registrados, para poder verificar qué mandó realmente la app (headers, cuerpo).
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    const call: RecordedCall = {
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);

    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ message: `sin ruta ${method} ${path}` }), { status: 404 });
    const reply = typeof handler === 'function' ? handler(call) : handler;
    // Una respuesta 204 no puede traer cuerpo (el constructor de Response lo prohíbe)
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? null), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock, callsTo: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

export const USER: User = { id: 'u1', email: 'ana@example.com', name: 'Ana García', role: 'CUSTOMER' };

export function signIn(user: User = USER) {
  localStorage.setItem('reservas.session', JSON.stringify({ token: 'jwt-de-prueba', user }));
}

export function renderApp(route: string) {
  const store = createStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } } });
  const utils = render(
    <AppProviders store={store} queryClient={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, store, queryClient };
}

export const RESERVATION_ID = '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10';

export function payment(overrides: Partial<Payment> = {}): Payment {
  return { id: 'pay-1', status: 'PENDING', amountCents: 400000, currency: 'ARS', expiresAt: future(), failureReason: null, ...overrides };
}

export function future(minutes = 15): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: RESERVATION_ID,
    restaurantId: '64b7f0c2a1b2c3d4e5f60718',
    restaurant: { id: '64b7f0c2a1b2c3d4e5f60718', name: 'La Esquina de Don Pepe' },
    tableNumber: 2,
    partySize: 2,
    startsAt: '2026-10-17T00:00:00.000Z',
    endsAt: '2026-10-17T01:30:00.000Z',
    status: 'PENDING_PAYMENT',
    depositCents: 400000,
    expiresAt: future(),
    notes: null,
    payment: payment(),
    ...overrides,
  };
}
