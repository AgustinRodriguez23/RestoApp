/**
 * Vuelve las cuentas de demo (los botones "Probar como…" del login) a su estado modelo. Lo corre un cron todas las
 * noches: las cuentas son compartidas, así que lo que un visitante cambia o rompe, al otro día ya no está.
 *
 * - Cliente de demo: cancela sus reservas por venir (pendientes de pago o confirmadas). Así libera las mesas y no
 *   llega al tope de reservas sin pagar.
 * - Dueño de demo: deja UN restaurante modelo, con sus datos, mesas, horarios y carta originales, y borra el resto.
 *   Si el modelo ya existe se corrige en el lugar (no se borra y se crea de nuevo), así conserva su id y su historial
 *   de reservas.
 * - Agenda de ejemplo: para que el panel del dueño no esté vacío, 4 clientes ficticios mantienen reservadas las
 *   próximas noches del restaurante modelo (la mayoría pagadas, alguna con el pago rechazado), y las de días pasados
 *   que siguen confirmadas se marcan como "asistió" o "no vino". Solo se puede reservar a futuro, así que el
 *   historial se arma de a un día por noche.
 *
 * Usa la API del BFF, igual que el front: no toca las bases. Es seguro repetirlo. Sin las variables de una cuenta,
 * esa parte se saltea (la agenda necesita la del dueño).
 *
 * Uso en el servidor (con el entorno del web-bff, que ya tiene las DEMO_*): ver "Cuentas de demo" en docs/OPERACION.md
 * Uso local:  DEMO_OWNER_EMAIL=… DEMO_OWNER_PASSWORD=… node scripts/demo-reset.mjs
 * Variables: BFF_URL (http://localhost:3000), DEMO_OWNER_EMAIL, DEMO_OWNER_PASSWORD, DEMO_CUSTOMER_EMAIL, DEMO_CUSTOMER_PASSWORD
 * Sin librerías (Node 20+).
 */
import { createHmac } from 'node:crypto';

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

/** Los que reservan en la agenda de ejemplo. Se registran solos la primera vez. */
const SAMPLE_CUSTOMERS = [
  { email: 'demo-ejemplo-1@example.com', name: 'Lucía Fernández' },
  { email: 'demo-ejemplo-2@example.com', name: 'Martín Gómez' },
  { email: 'demo-ejemplo-3@example.com', name: 'Sofía Romero' },
  { email: 'demo-ejemplo-4@example.com', name: 'Diego Sosa' },
];

/** Los horarios de un día de la agenda. Cada día queda uno libre y otro con el pago rechazado (ver planFor). */
const SAMPLE_SLOTS = [
  { time: '12:30', partySize: 2 },
  { time: '13:00', partySize: 4, notes: 'Mesa cerca de la ventana, si se puede' },
  { time: '13:30', partySize: 3 },
  { time: '20:30', partySize: 4 },
  { time: '21:00', partySize: 2 },
  { time: '21:00', partySize: 6, notes: 'Cumpleaños: traemos la torta' },
  { time: '21:30', partySize: 5 },
  { time: '22:00', partySize: 2 },
];

/** Cuántos días para adelante (contando hoy) se mantienen reservados, y cuántos para atrás se marcan. */
const AGENDA_DAYS_AHEAD = 7;
const AGENDA_DAYS_BACK = 3;

/** La zona del restaurante (RESTAURANT_TIME_ZONE de reservations-service). Argentina no tiene horario de verano. */
const TIME_ZONE = 'America/Argentina/Buenos_Aires';
const UTC_OFFSET = '-03:00';

/** La fecha (YYYY-MM-DD) en la zona del restaurante, corrida `offsetDays` días desde hoy. */
function localDate(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

/** Un número fijo a partir de un texto: el plan de cada día sale siempre igual, sin guardar nada. */
function hash(text) {
  let h = 0;
  for (const char of text) h = (Math.imul(h, 31) + char.charCodeAt(0)) >>> 0;
  return h;
}

/** Las reservas de ejemplo de un día. Cambia de un día a otro, pero el mismo día da siempre lo mismo. */
function planFor(date) {
  const h = hash(date);
  const free = h % SAMPLE_SLOTS.length;
  const declined = (free + 1 + ((h >>> 8) % (SAMPLE_SLOTS.length - 1))) % SAMPLE_SLOTS.length;
  return SAMPLE_SLOTS.flatMap(({ time, ...slot }, i) =>
    i === free
      ? []
      : [
          {
            ...slot,
            startsAt: `${date}T${time}:00${UTC_OFFSET}`,
            // Índices seguidos, clientes distintos: los dos de las 21:00 nunca son la misma persona
            customer: (i + h) % SAMPLE_CUSTOMERS.length,
            token: i === declined ? 'tok_declined' : 'tok_approved',
          },
        ],
  );
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function http(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${BFF}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new HttpError(`${method} ${path} respondió ${res.status}: ${JSON.stringify(parsed)}`, res.status);
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return { token, restaurantId: id };
}

/**
 * La contraseña de un cliente de ejemplo: un HMAC de su email con la contraseña del dueño de demo. Da siempre lo
 * mismo, así que no hace falta guardarla en ningún lado, y sin la del dueño no se puede adivinar. Si cambia
 * DEMO_OWNER_PASSWORD, estos clientes ya no pueden entrar (ver "Cuentas de demo" en docs/OPERACION.md).
 */
function samplePassword(ownerPassword, email) {
  return createHmac('sha256', ownerPassword).update(`restoapp-demo:${email}`).digest('base64url').slice(0, 32);
}

/** Entra con un cliente de ejemplo; si todavía no existe, lo registra. */
async function enterSampleCustomer({ email, name }, ownerPassword) {
  const password = samplePassword(ownerPassword, email);
  try {
    return await http('POST', '/auth/login', { body: { email, password } });
  } catch (error) {
    if (error.status !== 401) throw error;
  }
  try {
    return await http('POST', '/auth/register', { body: { email, name, password } });
  } catch (error) {
    if (error.status === 409) {
      throw new Error(`${email} existe pero no acepta la contraseña: ¿cambió DEMO_OWNER_PASSWORD? (ver docs/OPERACION.md)`);
    }
    throw error;
  }
}

/** Reserva y paga la seña. Devuelve el estado en que quedó la reserva. */
async function book(token, restaurantId, { startsAt, partySize, notes, token: paymentToken }) {
  const body = { restaurantId, startsAt, partySize, ...(notes ? { notes } : {}) };
  let reservation;
  for (let attempt = 1; ; attempt++) {
    try {
      reservation = await http('POST', '/reservations', { token, body });
      break;
    } catch (error) {
      // 422 = ya tiene el máximo de reservas sin pagar: pasa si un pago rechazado recién se está procesando
      if (error.status !== 422 || attempt === 3) throw error;
      await sleep(2_000);
    }
  }
  // Sin seña configurada nace confirmada: no hay nada que pagar
  if (reservation.status !== 'PENDING_PAYMENT') return reservation.status;
  const payment = await http('POST', `/reservations/${reservation.id}/pay`, {
    token,
    body: { token: paymentToken },
    headers: { 'idempotency-key': `demo-agenda-${reservation.id}` },
  });
  // tok_approved y tok_declined responden al instante (los "slow" resuelven después, por webhook)
  return { SUCCEEDED: 'CONFIRMED', FAILED: 'CANCELLED' }[payment.status] ?? payment.status;
}

/** Todas las reservas de un día del restaurante (el listado viene paginado). */
async function reservationsOn(ownerToken, restaurantId, date) {
  const all = [];
  for (let page = 1; ; page++) {
    const result = await http('GET', `/owner/restaurants/${restaurantId}/reservations?date=${date}&limit=50&page=${page}`, { token: ownerToken });
    all.push(...result.data);
    if (page >= result.totalPages) return all;
  }
}

/** Mantiene la agenda de ejemplo del restaurante modelo: reservas por venir y asistencia de los días pasados. */
async function seedAgenda(ownerPassword, ownerToken, restaurantId) {
  const customers = [];
  for (const sample of SAMPLE_CUSTOMERS) customers.push(await enterSampleCustomer(sample, ownerPassword));
  // Las reservas de ejemplo se reconocen por el nombre, no por el id del cliente: si las cuentas se borran y se
  // vuelven a registrar (ver docs/OPERACION.md), sus reservas viejas siguen contando y no se duplica la agenda.
  const isSample = (reservation) => SAMPLE_CUSTOMERS.some((c) => c.name === reservation.customerName);

  // Días pasados: lo que quedó confirmado se marca. Uno por día "no vino"; el resto, "asistió".
  let completed = 0;
  let noShow = 0;
  for (let offset = -AGENDA_DAYS_BACK; offset < 0; offset++) {
    const date = localDate(offset);
    const pending = (await reservationsOn(ownerToken, restaurantId, date))
      .filter((r) => r.status === 'CONFIRMED' && isSample(r))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    const absent = pending.length > 1 ? hash(date) % pending.length : -1;
    for (const [i, reservation] of pending.entries()) {
      const status = i === absent ? 'NO_SHOW' : 'COMPLETED';
      await http('PATCH', `/owner/reservations/${reservation.id}/status`, { token: ownerToken, body: { status } });
      if (status === 'NO_SHOW') noShow++;
      else completed++;
    }
  }

  // De hoy en adelante: se crea lo que falta del plan. Si ya hay una reserva de ese cliente a esa hora, en el
  // estado que sea (aunque un visitante la haya cancelado), ya está hecha.
  const created = { CONFIRMED: 0, CANCELLED: 0 };
  let skipped = 0;
  for (let offset = 0; offset < AGENDA_DAYS_AHEAD; offset++) {
    const date = localDate(offset);
    const existing = await reservationsOn(ownerToken, restaurantId, date);
    for (const entry of planFor(date)) {
      const customer = customers[entry.customer];
      const { name } = SAMPLE_CUSTOMERS[entry.customer];
      const startsAt = new Date(entry.startsAt).getTime();
      // Hoy, lo que ya empezó no se puede reservar (la API solo acepta reservas a futuro)
      if (startsAt <= Date.now()) continue;
      if (existing.some((r) => r.customerName === name && new Date(r.startsAt).getTime() === startsAt)) continue;
      try {
        const status = await book(customer.accessToken, restaurantId, entry);
        created[status] = (created[status] ?? 0) + 1;
      } catch (error) {
        // 409 = no hay mesa libre (la ocupó un visitante): se saltea ese horario, el resto de la agenda sigue
        if (error.status !== 409) throw error;
        skipped++;
        console.log(`agenda de ejemplo: sin mesa para ${entry.partySize} el ${entry.startsAt}, se saltea`);
      }
    }
  }

  console.log(
    `agenda de ejemplo: ${created.CONFIRMED} reservas pagadas y ${created.CANCELLED} con el pago rechazado creadas` +
      `${skipped ? `, ${skipped} salteadas` : ''}; días pasados: ${completed} marcadas como "asistió" y ${noShow} como "no vino"`,
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

/** Corre un paso; si falla, lo anota y sigue con el próximo. */
async function step(label, run) {
  try {
    return await run();
  } catch (error) {
    failed = true;
    console.error(`${label}: falló: ${error.message}`);
    return undefined;
  }
}

// Primero el cliente: así sus reservas se cancelan mientras el restaurante todavía existe
if (customer) await step('cliente de demo', () => resetCustomer(customer));
else console.log('cliente de demo: sin configurar, se saltea');

if (owner) {
  const model = await step('dueño de demo', () => resetOwner(owner));
  // Sin el restaurante modelo no hay dónde armar la agenda
  if (model) await step('agenda de ejemplo', () => seedAgenda(owner.password, model.token, model.restaurantId));
} else {
  console.log('dueño de demo: sin configurar, se saltea (y la agenda de ejemplo también)');
}
console.log(failed ? 'reseteo con errores' : 'reseteo ok');
process.exit(failed ? 1 : 0);
