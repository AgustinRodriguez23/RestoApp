import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MenuCategory, MenuItem, User } from '../api/types';
import { mockApi, renderApp, signIn } from '../test/harness';

const OWNER: User = { id: 'o1', email: 'dueno@example.com', name: 'Don Pepe', role: 'RESTAURANT_OWNER' };
const RID = '64b7f0c2a1b2c3d4e5f60718';
const restaurant = { id: RID, name: 'La Esquina', cuisine: 'Parrilla', address: 'Av. 1', openingHours: [], tables: [] };
const item = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: 'i1',
  category: 'Postres',
  name: 'Flan casero',
  description: 'Con dulce de leche',
  priceCents: 450000,
  allergens: ['MILK', 'EGGS'],
  variants: [{ name: 'Con crema', priceDeltaCents: 50000 }],
  available: true,
  ...over,
});
const menuOf = (...items: MenuItem[]): MenuCategory[] => {
  const groups = new Map<string, MenuItem[]>();
  for (const i of items) groups.set(i.category, [...(groups.get(i.category) ?? []), i]);
  return [...groups].map(([category, list]) => ({ category, items: list }));
};
const MENU = `GET /owner/restaurants/${RID}/menu`;
const ITEMS = `/owner/restaurants/${RID}/menu-items`;
const base = { 'GET /owner/restaurants': { body: [restaurant] } };

describe('MenuPage', () => {
  it('muestra la carta por categoría con precio, alérgenos, variantes y platos pausados', async () => {
    mockApi({ ...base, [MENU]: { body: menuOf(item(), item({ id: 'i2', name: 'Bife', category: 'Principales', available: false, allergens: [], variants: [] })) } });
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    expect(await screen.findByRole('heading', { name: 'Postres' })).toBeInTheDocument();
    expect(screen.getByText(/Flan casero · .*4\.500/)).toBeInTheDocument();
    expect(screen.getByText('Contiene: lácteos, huevo')).toBeInTheDocument();
    expect(screen.getByText(/Con crema \(\+.*500\)/)).toBeInTheDocument();
    expect(screen.getByText('Pausado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activar Bife' })).toBeInTheDocument();
  });

  it('carta vacía: lo explica', async () => {
    mockApi({ ...base, [MENU]: { body: [] } });
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    expect(await screen.findByText('La carta todavía está vacía')).toBeInTheDocument();
  });

  it('agrega un plato: precio en pesos con coma, alérgenos y variante, y llega en centavos', async () => {
    const server = mockApi({ ...base, [MENU]: { body: [] }, [`POST ${ITEMS}`]: { status: 201, body: item() } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    await user.click(await screen.findByRole('button', { name: 'Agregar plato' }));
    const form = screen.getByRole('form', { name: 'Nuevo plato' });
    await user.type(within(form).getByLabelText(/Categoría/), 'Postres');
    await user.type(within(form).getByLabelText('Nombre del plato'), 'Flan casero');
    await user.type(within(form).getByLabelText(/Precio \(\$\)/), '4500,50');
    await user.click(within(form).getByLabelText('lácteos'));
    await user.click(within(form).getByLabelText('huevo'));
    await user.click(within(form).getByRole('button', { name: 'Agregar variante' }));
    await user.type(within(form).getByLabelText('Nombre de la variante 1'), 'Con crema');
    await user.clear(within(form).getByLabelText(/Diferencia de precio 1/));
    await user.type(within(form).getByLabelText(/Diferencia de precio 1/), '-100');
    await user.click(within(form).getByRole('button', { name: 'Agregar plato' }));

    expect(await screen.findByText('Plato agregado')).toBeInTheDocument();
    expect(server.callsTo('POST', ITEMS)[0]?.body).toEqual({
      category: 'Postres',
      name: 'Flan casero',
      description: '',
      priceCents: 450050,
      allergens: ['MILK', 'EGGS'],
      variants: [{ name: 'Con crema', priceDeltaCents: -10000 }],
      available: true,
    });
    expect(screen.queryByRole('form', { name: 'Nuevo plato' })).not.toBeInTheDocument();
  });

  it('con datos inválidos muestra los errores y no llama al servidor', async () => {
    const server = mockApi({ ...base, [MENU]: { body: [] } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    await user.click(await screen.findByRole('button', { name: 'Agregar plato' }));
    await user.type(screen.getByLabelText(/Precio \(\$\)/), 'gratis');
    await user.click(within(screen.getByRole('form', { name: 'Nuevo plato' })).getByRole('button', { name: 'Agregar plato' }));

    expect(await screen.findByText(/Poné un precio válido/)).toBeInTheDocument();
    expect(screen.getByText(/La categoría tiene que tener/)).toBeInTheDocument();
    expect(server.callsTo('POST', ITEMS)).toHaveLength(0);
  });

  it('edita un plato con sus datos cargados', async () => {
    const server = mockApi({ ...base, [MENU]: { body: menuOf(item()) }, [`PATCH ${ITEMS}/i1`]: { body: item() } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    await user.click(await screen.findByRole('button', { name: 'Editar Flan casero' }));
    const form = screen.getByRole('form', { name: 'Editar plato' });
    expect(within(form).getByLabelText(/Precio \(\$\)/)).toHaveValue('4500');
    expect(within(form).getByLabelText('lácteos')).toBeChecked();
    expect(within(form).getByLabelText('Nombre de la variante 1')).toHaveValue('Con crema');

    await user.clear(within(form).getByLabelText(/Precio \(\$\)/));
    await user.type(within(form).getByLabelText(/Precio \(\$\)/), '5000');
    await user.click(within(form).getByRole('button', { name: 'Guardar cambios' }));

    expect(await screen.findByText('Plato actualizado')).toBeInTheDocument();
    expect(server.callsTo('PATCH', `${ITEMS}/i1`)[0]?.body).toMatchObject({ priceCents: 500000, name: 'Flan casero', allergens: ['MILK', 'EGGS'] });
  });

  it('pausar y activar un plato manda solo "available"', async () => {
    const server = mockApi({ ...base, [MENU]: { body: menuOf(item()) }, [`PATCH ${ITEMS}/i1`]: { body: item({ available: false }) } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    await user.click(await screen.findByRole('button', { name: 'Pausar Flan casero' }));

    await waitFor(() => expect(server.callsTo('PATCH', `${ITEMS}/i1`)).toHaveLength(1));
    expect(server.callsTo('PATCH', `${ITEMS}/i1`)[0]?.body).toEqual({ available: false });
  });

  it('quitar pide confirmación y después borra', async () => {
    const server = mockApi({ ...base, [MENU]: { body: menuOf(item()) }, [`DELETE ${ITEMS}/i1`]: { status: 204 } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    await user.click(await screen.findByRole('button', { name: 'Quitar Flan casero' }));
    expect(screen.getByText(/¿Quitar «Flan casero» de la carta\?/)).toBeInTheDocument();
    expect(server.callsTo('DELETE', `${ITEMS}/i1`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Sí, quitar' }));

    expect(await screen.findByText('Plato quitado')).toBeInTheDocument();
    expect(server.callsTo('DELETE', `${ITEMS}/i1`)).toHaveLength(1);
  });

  it('muestra el error del servidor si no puede guardar', async () => {
    mockApi({ ...base, [MENU]: { body: menuOf(item()) }, [`PATCH ${ITEMS}/i1`]: { status: 403, body: { message: 'No sos el dueño de este restaurante' } } });
    const user = userEvent.setup();
    signIn(OWNER);
    renderApp(`/panel/restaurantes/${RID}/carta`);

    await user.click(await screen.findByRole('button', { name: 'Pausar Flan casero' }));

    expect(await screen.findByText('No sos el dueño de este restaurante')).toBeInTheDocument();
  });

  it('desde el panel hay un link a la carta del restaurante elegido', async () => {
    mockApi({ ...base, [`GET /owner/restaurants/${RID}/reservations`]: { body: { data: [], page: 1, limit: 20, total: 0, totalPages: 0 } } });
    signIn(OWNER);
    renderApp('/panel');

    expect(await screen.findByRole('link', { name: 'Editar la carta' })).toHaveAttribute('href', `/panel/restaurantes/${RID}/carta`);
  });
});
