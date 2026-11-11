/**
 * Vuelve las cuentas de demo (los botones "Probar como…" del login) a su estado modelo. Lo corre un cron todas las
 * noches: las cuentas son compartidas, así que lo que un visitante cambia o rompe, al otro día ya no está.
 *
 * - Cliente de demo: cancela sus reservas por venir (pendientes de pago o confirmadas). Así libera las mesas y no
 *   llega al tope de reservas sin pagar.
 * - Dueño de demo: deja UN restaurante modelo, con sus datos, mesas, horarios y carta originales, y borra el resto.
 *   Si el modelo ya existe se corrige en el lugar (no se borra y se crea de nuevo), así conserva su id y su historial
 *   de reservas.
 *
 * Usa la API del BFF, igual que el front: no toca las bases. Es seguro repetirlo. Sin las variables de una cuenta,
 * esa parte se saltea.
 *
 * Uso en el servidor (con el entorno del web-bff, que ya tiene las DEMO_*): ver "Cuentas de demo" en docs/OPERACION.md
 * Uso local:  DEMO_OWNER_EMAIL=… DEMO_OWNER_PASSWORD=… node scripts/demo-reset.mjs
 * Variables: BFF_URL (http://localhost:3000), DEMO_OWNER_EMAIL, DEMO_OWNER_PASSWORD, DEMO_CUSTOMER_EMAIL, DEMO_CUSTOMER_PASSWORD
 * Sin librerías (Node 20+).
 */
const BFF = (process.env.BFF_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** El restaurante que ve quien prueba como dueño (y donde reserva quien prueba como cliente). */
const MODEL_RESTAURANT = {
  name: 'Bodegón La Demo',
  description:
    'Restaurante de demostración de RestoApp. Probá reservar una mesa como cliente, o entrá como dueño para ver el panel. Todo vuelve a como estaba cada noche.',
  cuisine: 'Bodegón',
  address: 'Av. Rivadavia 4500, CABA',
  phone: '+54 11 4000-0000',
  // Todos los días, mediodía y noche. La noche cierra 00:30: un cierre menor que la apertura es del día siguiente.
  openingHours: [0, 1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
    { dayOfWeek, opens: '12:00', closes: '16:00' },
    { dayOfWeek, opens: '20:00', closes: '00:30' },
  ]),
  tables: [
    { number: 1, capacity: 2 },
    { number: 2, capacity: 2 },
    { number: 3, capacity: 4 },
    { number: 4, capacity: 4 },
    { number: 5, capacity: 4 },
    { number: 6, capacity: 6 },
    { number: 7, capacity: 8 },
  ],
};

const item = (category, name, description, priceCents, allergens = [], variants = []) => ({
  category,
  name,
  description,
  priceCents,
  allergens,
  variants,
  available: true,
});

const MODEL_MENU = [
  item('Entradas', 'Provoleta', 'A la parrilla, con orégano y aceite de oliva', 950000, ['MILK']),
  item('Entradas', 'Empanadas de carne', 'Cortadas a cuchillo, fritas o al horno (la unidad)', 280000, ['GLUTEN', 'EGGS']),
  item('Platos principales', 'Bife de chorizo', 'Con guarnición a elección', 2450000, [], [
    { name: 'Jugoso', priceDeltaCents: 0 },
    { name: 'A punto', priceDeltaCents: 0 },
    { name: 'Cocido', priceDeltaCents: 0 },
  ]),
  item('Platos principales', 'Milanesa napolitana', 'Con jamón, salsa de tomate y mozzarella', 1890000, ['GLUTEN', 'EGGS', 'MILK'], [
    { name: 'Para compartir', priceDeltaCents: 1200000 },
  ]),
  item('Platos principales', 'Ñoquis de papa', 'Con salsa fileto o bolognesa', 1490000, ['GLUTEN', 'EGGS']),
  item('Guarniciones', 'Papas fritas', 'Cortadas a mano', 690000),
  item('Guarniciones', 'Ensalada mixta', 'Lechuga, tomate y cebolla', 590000),
  item('Postres', 'Flan casero', 'Con dulce de leche o crema', 650000, ['EGGS', 'MILK']),
  item('Postres', 'Panqueque con dulce de leche', null, 720000, ['GLUTEN', 'EGGS', 'MILK']),
  item('Bebidas', 'Agua sin gas', '500 ml', 250000),
  item('Bebidas', 'Vino de la casa', 'Malbec, la copa', 450000, ['SULPHITES'], [{ name: 'Botella', priceDeltaCents: 1350000 }]),
].map(({ description, ...rest }) => (description ? { ...rest, description } : rest));

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${BFF}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} respondió ${res.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

function account(prefix) {
  const email = process.env[`${prefix}_EMAIL`]?.trim();
  const password = process.env[`${prefix}_PASSWORD`];
  return email && password ? { email, password } : null;
}

async function login({ email, password }) {
  return (await http('POST', '/auth/login', { body: { email, password } })).accessToken;
}

/** Cancela las reservas por venir del cliente de demo. */
async function resetCustomer(credentials) {
  const token = await login(credentials);
  let cancelled = 0;
  for (const status of ['PENDING_PAYMENT', 'CONFIRMED']) {
    // Siempre la página 1: lo cancelado deja de aparecer en este filtro, así que la lista se va achicando
    for (let round = 0; round < 20; round++) {
      const page = await http('GET', `/reservations/mine?status=${status}&limit=50`, { token });
      const upcoming = page.data.filter((r) => new Date(r.startsAt).getTime() > Date.now());
      if (upcoming.length === 0) break;
      for (const reservation of upcoming) {
        await http('POST', `/reservations/${reservation.id}/cancel`, { token });
        cancelled++;
      }
    }
  }
  console.log(`cliente de demo: ${cancelled} reservas por venir canceladas`);
}

/** Deja al dueño de demo con el restaurante modelo y nada más. */
async function resetOwner(credentials) {
  const token = await login(credentials);
  const mine = await http('GET', '/owner/restaurants', { token });

  // Se conserva el primero que se llame como el modelo (aunque alguien le haya cambiado todo lo demás)
  const keep = mine.find((r) => r.name === MODEL_RESTAURANT.name) ?? null;
  const extra = mine.filter((r) => r !== keep);

  for (const restaurant of extra) await http('DELETE', `/owner/restaurants/${restaurant.id}`, { token });

  let id;
  if (keep) {
    id = keep.id;
    await http('PATCH', `/owner/restaurants/${id}`, { token, body: MODEL_RESTAURANT });
  } else {
    id = (await http('POST', '/owner/restaurants', { token, body: MODEL_RESTAURANT })).id;
  }

  // La carta: se borra entera y se vuelve a cargar (incluye los platos pausados, que la carta pública no muestra)
  const menu = await http('GET', `/owner/restaurants/${id}/menu`, { token });
  const items = menu.flatMap((category) => category.items);
  for (const old of items) await http('DELETE', `/owner/restaurants/${id}/menu-items/${old.id}`, { token });
  for (const dish of MODEL_MENU) await http('POST', `/owner/restaurants/${id}/menu-items`, { token, body: dish });

  console.log(
    `dueño de demo: restaurante modelo ${keep ? 'corregido' : 'creado'} (${id}), ${extra.length} restaurantes de más borrados, ` +
      `carta recargada (${items.length} platos borrados, ${MODEL_MENU.length} creados)`,
  );
}

const customer = account('DEMO_CUSTOMER');
const owner = account('DEMO_OWNER');
if (!customer && !owner) {
  console.log('No hay cuentas de demo configuradas (DEMO_*): nada que hacer.');
  process.exit(0);
}

const started = new Date();
console.log(`${started.toISOString()} reseteo de la demo contra ${BFF}`);
let failed = false;
// Primero el cliente: así sus reservas se cancelan mientras el restaurante todavía existe
for (const [label, credentials, reset] of [
  ['cliente', customer, resetCustomer],
  ['dueño', owner, resetOwner],
]) {
  if (!credentials) {
    console.log(`${label} de demo: sin configurar, se saltea`);
    continue;
  }
  try {
    await reset(credentials);
  } catch (error) {
    failed = true;
    console.error(`${label} de demo: falló: ${error.message}`);
  }
}
console.log(failed ? 'reseteo con errores' : 'reseteo ok');
process.exit(failed ? 1 : 0);
