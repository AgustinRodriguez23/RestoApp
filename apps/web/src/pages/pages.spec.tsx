import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, payment, renderApp, reservation, RESERVATION_ID, signIn, USER } from '../test/harness';

const RID = '64b7f0c2a1b2c3d4e5f60718';
const restaurant = {
  id: RID,
  name: 'La Esquina de Don Pepe',
  cuisine: 'Parrilla',
  address: 'Av. Corrientes 1234',
  openingHours: [],
  tables: [{ number: 1, capacity: 4 }],
};
const slot = (hour: number) => ({ startsAt: `2026-10-17T${String(hour).padStart(2, '0')}:00:00.000Z`, endsAt: `2026-10-17T${String(hour + 2).padStart(2, '0')}:30:00.000Z`, availableTables: 2 });

describe('LoginPage', () => {
  it('inicia sesión, guarda la sesión y vuelve a donde se quería ir', async () => {
    const server = mockApi({
      'POST /auth/login': { body: { accessToken: 'jwt-1', user: USER } },
      'GET /reservations/mine': { body: { data: [], page: 1, limit: 50, total: 0, totalPages: 0 } },
    });
    const user = userEvent.setup();
    renderApp('/reservas'); // sin sesión: RequireAuth manda al login

    await user.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Contraseña'), 'Password123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('heading', { name: 'Mis reservas' })).toBeInTheDocument();
    expect(server.callsTo('POST', '/auth/login')[0]?.body).toEqual({ email: 'ana@example.com', password: 'Password123' });
    expect(JSON.parse(localStorage.getItem('reservas.session') ?? '{}')).toMatchObject({ token: 'jwt-1' });
    // y el pedido siguiente ya lleva el token
    await waitFor(() => expect(server.callsTo('GET', '/reservations/mine')[0]?.headers.Authorization).toBe('Bearer jwt-1'));
  });

  it('muestra el error del servidor y no inicia sesión', async () => {
    mockApi({ 'POST /auth/login': { status: 401, body: { message: 'Email o contraseña incorrectos' } } });
    const user = userEvent.setup();
    renderApp('/ingresar');

    await user.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Contraseña'), 'mala-clave');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email o contraseña incorrectos');
    expect(localStorage.getItem('reservas.session')).toBeNull();
  });

  it('crear cuenta registra y luego inicia sesión', async () => {
    const server = mockApi({
      'POST /auth/register': { status: 201, body: USER },
      'POST /auth/login': { body: { accessToken: 'jwt-2', user: USER } },
      'GET /restaurants': { body: { data: [], page: 1, limit: 9, total: 0, totalPages: 0 } },
    });
    const user = userEvent.setup();
    renderApp('/ingresar');

    await user.click(await screen.findByRole('tab', { name: 'Crear cuenta' }));
    await user.type(screen.getByLabelText('Nombre'), 'Ana García');
    await user.type(screen.getByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText(/^Contraseña/), 'Password123');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    await screen.findByText(/Elegí dónde comer/);
    expect(server.callsTo('POST', '/auth/register')[0]?.body).toEqual({ name: 'Ana García', email: 'ana@example.com', password: 'Password123' });
  });
});

describe('RestaurantsPage', () => {
  it('lista los restaurantes y busca por nombre una vez que se deja de tipear', async () => {
    const page = (data: unknown[]) => ({ body: { data, page: 1, limit: 9, total: data.length, totalPages: 1 } });
    const server = mockApi({
      'GET /restaurants': (call) => (call.query.search === 'nonna' ? page([{ ...restaurant, id: 'r2', name: 'Trattoria Nonna Rosa', cuisine: 'Italiana' }]) : page([restaurant])),
    });
    const user = userEvent.setup();
    renderApp('/');

    expect(await screen.findByText('La Esquina de Don Pepe')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Buscar por nombre'), 'nonna');

    expect(await screen.findByText('Trattoria Nonna Rosa')).toBeInTheDocument();
    expect(screen.queryByText('La Esquina de Don Pepe')).not.toBeInTheDocument();
    // una consulta por pausa, no una por letra
    expect(server.callsTo('GET', '/restaurants').filter((c) => c.query.search).length).toBe(1);
  });

  it('explica qué hacer cuando no hay resultados', async () => {
    mockApi({ 'GET /restaurants': { body: { data: [], page: 1, limit: 9, total: 0, totalPages: 0 } } });
    renderApp('/?q=zzz');
    expect(await screen.findByText('No encontramos restaurantes con esa búsqueda')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Borrar filtros' })).toBeInTheDocument();
  });

  it('un error de red ofrece reintentar', async () => {
    let fail = true;
    mockApi({
      'GET /restaurants': () => (fail ? { status: 503, body: { message: 'reservations-service no está disponible' } } : { body: { data: [restaurant], page: 1, limit: 9, total: 1, totalPages: 1 } }),
    });
    const user = userEvent.setup();
    renderApp('/');

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar los restaurantes');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('La Esquina de Don Pepe')).toBeInTheDocument();
  });
});

describe('RestaurantPage', () => {
  const overview = { restaurant, menu: [], availability: { restaurantId: RID, date: '2026-10-17', partySize: 2, durationMinutes: 90, timeZone: 'America/Argentina/Buenos_Aires', slots: [slot(0), slot(1)] }, warnings: [] };

  it('sin sesión pide ingresar y, al volver, el horario elegido sigue elegido (borrador en Redux)', async () => {
    mockApi({
      'GET /restaurants/64b7f0c2a1b2c3d4e5f60718/overview': { body: overview },
      'POST /auth/login': { body: { accessToken: 'jwt-1', user: USER } },
    });
    const user = userEvent.setup();
    renderApp(`/restaurantes/${RID}`);

    await user.click(await screen.findByRole('button', { name: /21:00/ })); // 00:00 UTC = 21:00 en Buenos Aires
    await user.click(screen.getByRole('button', { name: 'Ingresá para reservar' }));
    await user.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Contraseña'), 'Password123');
    await user.click(screen.getByRole('button', { name: 'Ingresar' }));

    expect(await screen.findByRole('button', { name: 'Reservar las 21:00 h' })).toBeEnabled();
  });

  it('reserva el horario elegido y lleva a pagar la seña', async () => {
    const server = mockApi({
      'GET /restaurants/64b7f0c2a1b2c3d4e5f60718/overview': { body: overview },
      'POST /reservations': { status: 201, body: reservation() },
      [`GET /reservations/${RESERVATION_ID}`]: { body: reservation() },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(`/restaurantes/${RID}`);

    expect(screen.queryByRole('button', { name: /Reservar las/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /22:00/ }));
    await user.type(screen.getByLabelText(/Aclaraciones/), 'Cumpleaños');
    await user.click(screen.getByRole('button', { name: 'Reservar las 22:00 h' }));

    expect(await screen.findByRole('heading', { name: 'Pagá la seña para confirmar' })).toBeInTheDocument();
    expect(server.callsTo('POST', '/reservations')[0]?.body).toEqual({ restaurantId: RID, partySize: 2, startsAt: '2026-10-17T01:00:00.000Z', notes: 'Cumpleaños' });
  });

  it('si el horario se ocupó (409) avisa, lo deselecciona y vuelve a pedir los libres', async () => {
    const server = mockApi({
      'GET /restaurants/64b7f0c2a1b2c3d4e5f60718/overview': { body: overview },
      'POST /reservations': { status: 409, body: { message: 'Ya no hay mesas libres en ese horario' } },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(`/restaurantes/${RID}`);

    await user.click(await screen.findByRole('button', { name: /21:00/ }));
    await user.click(screen.getByRole('button', { name: 'Reservar las 21:00 h' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ya no hay mesas libres');
    expect(screen.getByRole('button', { name: 'Elegí un horario' })).toBeDisabled();
    await waitFor(() => expect(server.callsTo('GET', `/restaurants/${RID}/overview`).length).toBeGreaterThan(1));
  });

  it('sin horarios libres dice qué probar; y si falla la carta igual se puede reservar', async () => {
    mockApi({
      'GET /restaurants/64b7f0c2a1b2c3d4e5f60718/overview': {
        body: { ...overview, menu: null, availability: { ...overview.availability, slots: [] }, warnings: [{ section: 'menu', message: 'No pudimos cargar la carta' }] },
      },
    });
    renderApp(`/restaurantes/${RID}`);
    expect(await screen.findByText('No hay horarios libres ese día')).toBeInTheDocument();
    expect(screen.getByText('Carta no disponible')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'La Esquina de Don Pepe' })).toBeInTheDocument();
  });
});

describe('PaymentPage', () => {
  const route = `/reservas/${RESERVATION_ID}/pagar`;
  const confirmed = reservation({ status: 'CONFIRMED', expiresAt: null, payment: payment({ status: 'SUCCEEDED' }) });

  it('pago aprobado: manda la clave de idempotencia y termina en reserva confirmada', async () => {
    let paid = false;
    const server = mockApi({
      [`GET /reservations/${RESERVATION_ID}`]: () => ({ body: paid ? confirmed : reservation() }),
      [`POST /reservations/${RESERVATION_ID}/pay`]: () => {
        paid = true;
        return { body: payment({ status: 'SUCCEEDED' }) };
      },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(route);

    await user.click(await screen.findByRole('button', { name: /^Pagar/ }));

    expect(await screen.findByRole('heading', { name: 'Reserva confirmada' })).toBeInTheDocument();
    const call = server.callsTo('POST', `/reservations/${RESERVATION_ID}/pay`)[0];
    expect(call?.body).toEqual({ token: 'tok_approved' });
    expect(call?.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });

  it('un corte de red NO cambia la clave: reintentar con el mismo pedido no puede cobrar dos veces', async () => {
    let attempts = 0;
    const server = mockApi({
      [`GET /reservations/${RESERVATION_ID}`]: { body: reservation() },
      [`POST /reservations/${RESERVATION_ID}/pay`]: () => {
        attempts += 1;
        return attempts === 1 ? { status: 502, body: { message: 'La pasarela no responde' } } : { body: payment({ status: 'SUCCEEDED' }) };
      },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(route);

    await user.click(await screen.findByRole('button', { name: /^Pagar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se cobró nada');
    await user.click(screen.getByRole('button', { name: /^Pagar/ }));
    await waitFor(() => expect(server.callsTo('POST', `/reservations/${RESERVATION_ID}/pay`)).toHaveLength(2));

    const [first, second] = server.callsTo('POST', `/reservations/${RESERVATION_ID}/pay`);
    expect(second?.headers['Idempotency-Key']).toBe(first?.headers['Idempotency-Key']);
  });

  it('cambiar el medio de pago usa otra clave (el servidor rechaza la misma clave con otro contenido)', async () => {
    const server = mockApi({
      [`GET /reservations/${RESERVATION_ID}`]: { body: reservation() },
      [`POST /reservations/${RESERVATION_ID}/pay`]: { status: 502, body: { message: 'La pasarela no responde' } },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(route);

    await user.click(await screen.findByRole('button', { name: /^Pagar/ }));
    await screen.findByRole('alert');
    await user.click(screen.getByLabelText(/Pasarela caída/));
    await user.click(screen.getByRole('button', { name: /^Pagar/ }));
    await waitFor(() => expect(server.callsTo('POST', `/reservations/${RESERVATION_ID}/pay`)).toHaveLength(2));

    const [first, second] = server.callsTo('POST', `/reservations/${RESERVATION_ID}/pay`);
    expect(second?.headers['Idempotency-Key']).not.toBe(first?.headers['Idempotency-Key']);
    expect(second?.body).toEqual({ token: 'tok_error' });
  });

  it('pago rechazado: lo explica y avisa que la reserva se cancela', async () => {
    mockApi({
      [`GET /reservations/${RESERVATION_ID}`]: { body: reservation() },
      [`POST /reservations/${RESERVATION_ID}/pay`]: { body: payment({ status: 'FAILED', failureReason: 'Fondos insuficientes' }) },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(route);

    await user.click(await screen.findByLabelText(/Sin fondos/));
    await user.click(screen.getByRole('button', { name: /^Pagar/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Pago rechazado');
    expect(alert).toHaveTextContent('Fondos insuficientes');
  });

  it('pago lento (202): muestra "procesando" y se confirma solo cuando la pasarela avisa', async () => {
    let polls = 0;
    mockApi({
      [`GET /reservations/${RESERVATION_ID}`]: () => {
        polls += 1;
        if (polls < 2) return { body: reservation() };
        return { body: polls < 3 ? reservation({ payment: payment({ status: 'PROCESSING' }) }) : confirmed };
      },
      [`POST /reservations/${RESERVATION_ID}/pay`]: { status: 202, body: payment({ status: 'PROCESSING' }) },
    });
    signIn();
    const user = userEvent.setup();
    renderApp(route);

    await user.click(await screen.findByLabelText(/Pago lento/));
    await user.click(screen.getByRole('button', { name: /^Pagar/ }));

    expect(await screen.findByText(/procesando tu pago/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pagar/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Reserva confirmada' }, { timeout: 8000 })).toBeInTheDocument();
  }, 12000);

  it('pago aprobado pero la reserva todavía no cambió (el evento está en camino): no deja pagar de nuevo y espera', async () => {
    let polls = 0;
    mockApi({
      [`GET /reservations/${RESERVATION_ID}`]: () => ({ body: ++polls < 2 ? reservation({ payment: payment({ status: 'SUCCEEDED' }) }) : confirmed }),
    });
    signIn();
    renderApp(route);

    expect(await screen.findByText(/Estamos confirmando tu reserva/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pagar/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Reserva confirmada' }, { timeout: 6000 })).toBeInTheDocument();
  }, 10000);

  it('una reserva vencida no se puede pagar y ofrece reservar de nuevo', async () => {
    mockApi({ [`GET /reservations/${RESERVATION_ID}`]: { body: reservation({ status: 'EXPIRED', payment: payment({ status: 'EXPIRED' }) }) } });
    signIn();
    renderApp(route);

    expect(await screen.findByText(/Pasó el plazo para pagar/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pagar/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reservar otro horario' })).toHaveAttribute('href', `/restaurantes/${RID}`);
  });

  it('la reserva de otra persona (404) no se muestra', async () => {
    mockApi({ [`GET /reservations/${RESERVATION_ID}`]: { status: 404, body: { message: 'Reserva no encontrada' } } });
    signIn();
    renderApp(route);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reserva no encontrada');
  });
});

describe('ReservationsPage', () => {
  const list = (data: unknown[]) => ({ body: { data, page: 1, limit: 50, total: data.length, totalPages: 1 } });

  it('cancela con confirmación y muestra la seña devuelta', async () => {
    let cancelled = false;
    const confirmedRes = reservation({ status: 'CONFIRMED', expiresAt: null, payment: payment({ status: 'SUCCEEDED' }) });
    const cancelledRes = reservation({ status: 'CANCELLED', expiresAt: null, payment: payment({ status: 'REFUNDED' }) });
    const server = mockApi({
      'GET /reservations/mine': () => list([cancelled ? cancelledRes : confirmedRes]),
      [`POST /reservations/${RESERVATION_ID}/cancel`]: () => {
        cancelled = true;
        return { body: cancelledRes };
      },
    });
    signIn();
    const user = userEvent.setup();
    renderApp('/reservas');

    await user.click(await screen.findByRole('button', { name: 'Cancelar' }));
    // todavía no se canceló: primero se pregunta
    expect(server.callsTo('POST', `/reservations/${RESERVATION_ID}/cancel`)).toHaveLength(0);
    expect(screen.getByText(/La seña se devuelve solo si faltan 24 horas/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sí, cancelar' }));

    const card = await screen.findByRole('article');
    await waitFor(() => expect(within(card).getByText('Seña devuelta')).toBeInTheDocument());
    expect(within(card).getByText('Cancelada')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Sí, cancelar' })).not.toBeInTheDocument();
  });

  it('"No, mantenerla" vuelve atrás sin cancelar', async () => {
    const server = mockApi({ 'GET /reservations/mine': list([reservation({ status: 'CONFIRMED', payment: payment({ status: 'SUCCEEDED' }) })]) });
    signIn();
    const user = userEvent.setup();
    renderApp('/reservas');

    await user.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await user.click(screen.getByRole('button', { name: 'No, mantenerla' }));

    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    expect(server.callsTo('POST', `/reservations/${RESERVATION_ID}/cancel`)).toHaveLength(0);
  });

  it('las reservas por pagar tienen el botón "Pagar seña" y el filtro pide solo ese estado', async () => {
    const server = mockApi({ 'GET /reservations/mine': (call) => list(call.query.status === 'PENDING_PAYMENT' ? [reservation()] : [reservation(), reservation({ id: 'otra', status: 'CANCELLED', payment: null })]) });
    signIn();
    const user = userEvent.setup();
    renderApp('/reservas');

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Por pagar' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));

    expect(screen.getByRole('link', { name: 'Pagar seña' })).toHaveAttribute('href', `/reservas/${RESERVATION_ID}/pagar`);
    expect(server.callsTo('GET', '/reservations/mine').some((c) => c.query.status === 'PENDING_PAYMENT')).toBe(true);
  });

  it('sin reservas invita a buscar un restaurante', async () => {
    mockApi({ 'GET /reservations/mine': list([]) });
    signIn();
    renderApp('/reservas');
    expect(await screen.findByText('Todavía no reservaste ninguna mesa')).toBeInTheDocument();
  });

  it('si el token venció (401) se cierra la sesión y se vuelve al login', async () => {
    mockApi({ 'GET /reservations/mine': { status: 401, body: { message: 'Token expirado' } } });
    signIn();
    renderApp('/reservas');

    expect(await screen.findByRole('heading', { name: 'Ingresá a tu cuenta' })).toBeInTheDocument();
    expect(localStorage.getItem('reservas.session')).toBeNull();
  });
});
