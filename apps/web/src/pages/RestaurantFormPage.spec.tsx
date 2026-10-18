import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { User } from '../api/types';
import { mockApi, renderApp, signIn } from '../test/harness';

const OWNER: User = { id: 'o1', email: 'dueno@example.com', name: 'Don Pepe', role: 'RESTAURANT_OWNER' };
const RID = '64b7f0c2a1b2c3d4e5f60718';
const existing = {
  id: RID,
  name: 'La Esquina',
  cuisine: 'Parrilla',
  address: 'Av. Corrientes 1234',
  phone: '+54 11 4444-5555',
  description: 'Parrilla de barrio',
  openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
  tables: [{ number: 1, capacity: 4 }, { number: 2, capacity: 2 }],
};

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Nombre'), 'La Parrilla');
  await user.type(screen.getByLabelText(/Tipo de cocina/), 'Parrilla');
  await user.type(screen.getByLabelText('Dirección'), 'Av. Mitre 1234');
}

describe('RestaurantFormPage · alta', () => {
  it('crea el restaurante, avisa y vuelve al panel', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [] },
      'POST /owner/restaurants': { status: 201, body: { ...existing, name: 'La Parrilla' } },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel/restaurantes/nuevo');

    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Crear restaurante' }));

    expect(await screen.findByText('Restaurante creado')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Panel del local' })).toBeInTheDocument();
    expect(server.callsTo('POST', '/owner/restaurants')[0]?.body).toMatchObject({
      name: 'La Parrilla',
      cuisine: 'Parrilla',
      address: 'Av. Mitre 1234',
      tables: [{ number: 1, capacity: 4 }],
      openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '23:30' }],
    });
    expect(server.callsTo('POST', '/owner/restaurants')[0]?.body).not.toHaveProperty('phone');
  });

  it('con datos inválidos muestra los errores y no llama al servidor', async () => {
    const server = mockApi({ 'GET /owner/restaurants': { body: [] } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel/restaurantes/nuevo');

    await user.click(await screen.findByRole('button', { name: 'Crear restaurante' }));

    expect(await screen.findByText(/El nombre tiene que tener/)).toBeInTheDocument();
    expect(screen.getByText(/La dirección tiene que tener/)).toBeInTheDocument();
    expect(server.callsTo('POST', '/owner/restaurants')).toHaveLength(0);
  });

  it('avisa de mesas repetidas', async () => {
    const server = mockApi({ 'GET /owner/restaurants': { body: [] } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel/restaurantes/nuevo');

    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Agregar mesa' }));
    await user.clear(screen.getByLabelText('Número de mesa 2'));
    await user.type(screen.getByLabelText('Número de mesa 2'), '1');
    await user.click(screen.getByRole('button', { name: 'Crear restaurante' }));

    expect(await screen.findByText('Hay números de mesa repetidos.')).toBeInTheDocument();
    expect(server.callsTo('POST', '/owner/restaurants')).toHaveLength(0);
  });

  it('agrega y quita mesas y repite el primer turno los siete días', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [] },
      'POST /owner/restaurants': { status: 201, body: existing },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel/restaurantes/nuevo');

    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Agregar mesa' }));
    expect(screen.getByLabelText('Número de mesa 2')).toHaveValue(2); // propone el siguiente número libre
    await user.click(screen.getByRole('button', { name: 'Quitar la mesa 1' }));
    await user.click(screen.getByRole('button', { name: 'Repetir el primer turno todos los días' }));
    await user.click(screen.getByRole('button', { name: 'Crear restaurante' }));

    await waitFor(() => expect(server.callsTo('POST', '/owner/restaurants')).toHaveLength(1));
    const body = server.callsTo('POST', '/owner/restaurants')[0]?.body as { tables: unknown[]; openingHours: unknown[] };
    expect(body.tables).toEqual([{ number: 2, capacity: 4 }]);
    expect(body.openingHours).toHaveLength(7);
  });

  it('muestra el error del servidor y conserva lo escrito', async () => {
    mockApi({
      'GET /owner/restaurants': { body: [] },
      'POST /owner/restaurants': { status: 400, body: { message: 'Un turno no puede abrir y cerrar a la misma hora' } },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp('/panel/restaurantes/nuevo');

    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Crear restaurante' }));

    expect(await screen.findByText(/misma hora/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nombre')).toHaveValue('La Parrilla');
  });
});

describe('RestaurantFormPage · edición y baja', () => {
  it('carga los datos, avisa lo de las reservas y guarda los cambios', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [existing] },
      [`PATCH /owner/restaurants/${RID}`]: { body: { ...existing, name: 'La Esquina Nueva' } },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}`);

    const name = await screen.findByLabelText('Nombre');
    expect(name).toHaveValue('La Esquina');
    expect(screen.getByLabelText('Número de mesa 2')).toHaveValue(2);
    expect(screen.getByText(/no se revisan/)).toBeInTheDocument();
    expect(screen.getByText(/no modifica las reservas ya hechas/)).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'La Esquina Nueva');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect(await screen.findByText('Cambios guardados')).toBeInTheDocument();
    expect(server.callsTo('PATCH', `/owner/restaurants/${RID}`)[0]?.body).toMatchObject({
      name: 'La Esquina Nueva',
      phone: '+54 11 4444-5555',
      tables: [{ number: 1, capacity: 4 }, { number: 2, capacity: 2 }],
      openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
    });
  });

  it('si el restaurante no es del usuario, lo dice', async () => {
    mockApi({ 'GET /owner/restaurants': { body: [existing] } });
    signIn(OWNER);
    renderApp('/panel/restaurantes/64b7f0c2a1b2c3d4e5f60999');

    expect(await screen.findByText(/No encontramos ese restaurante entre los tuyos/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar cambios' })).not.toBeInTheDocument();
  });

  it('eliminar pide confirmación, explica qué pasa con las reservas y borra', async () => {
    const server = mockApi({
      'GET /owner/restaurants': { body: [existing] },
      [`DELETE /owner/restaurants/${RID}`]: { status: 204 },
    });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}`);

    await user.click(await screen.findByRole('button', { name: 'Eliminar este restaurante' }));
    expect(screen.getByText(/no se cancelan/)).toBeInTheDocument();
    expect(server.callsTo('DELETE', `/owner/restaurants/${RID}`)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Sí, eliminar' }));

    expect(await screen.findByText('Restaurante eliminado')).toBeInTheDocument();
    expect(server.callsTo('DELETE', `/owner/restaurants/${RID}`)).toHaveLength(1);
  });

  it('"No" cancela la eliminación sin llamar al servidor', async () => {
    const server = mockApi({ 'GET /owner/restaurants': { body: [existing] } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}`);

    await user.click(await screen.findByRole('button', { name: 'Eliminar este restaurante' }));
    await user.click(screen.getByRole('button', { name: 'No' }));

    expect(screen.getByRole('button', { name: 'Eliminar este restaurante' })).toBeInTheDocument();
    expect(server.callsTo('DELETE', `/owner/restaurants/${RID}`)).toHaveLength(0);
  });

  it('un cliente que entra a la URL vuelve al inicio', async () => {
    mockApi({ 'GET /restaurants': { body: { data: [], page: 1, limit: 9, total: 0, totalPages: 0 } } });
    signIn({ id: 'u1', email: 'a@b.com', name: 'Ana', role: 'CUSTOMER' });
    renderApp('/panel/restaurantes/nuevo');

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Nuevo restaurante' })).not.toBeInTheDocument());
  });
});
