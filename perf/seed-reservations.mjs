/**
 * Carga un cliente con muchas reservas pagadas, para medir "Mis reservas" (perf/my-reservations.k6.js).
 * Esa pantalla pide hasta 50 reservas y el BFF le agrega a cada una el nombre del restaurante y el estado de su pago:
 * con pocas reservas no hay nada que medir.
 *
 * Crea 3 restaurantes "Perf Reservas" (de un dueño perf-owner-*) y el cliente perf-diner@example.com con COUNT reservas
 * con seña, cada una pagada con tok_approved. Las paga de a una y espera la confirmación: un cliente puede tener
 * como mucho 3 esperando el pago.
 *
 * Uso (con el sistema levantado):   node perf/seed-reservations.mjs
 * Variables: BFF_URL (http://localhost:3000)  RESTAURANTS_URL (http://localhost:3002)  COUNT (30)
 *
 * Si el cliente ya tiene COUNT reservas no hace nada. Se borra con node perf/cleanup.mjs. No usa librerías (Node 20+).
 */
import { randomUUID } from 'node:crypto';

const BFF = (process.env.BFF_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const RESTAURANTS = (process.env.RESTAURANTS_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const COUNT = Number(process.env.COUNT ?? 30);
const RESTAURANT_COUNT = 3;

const DINER = { email: 'perf-diner@example.com', password: 'Password123', name: 'Perf Diner' };

async function http(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

function expect(res, status, what) {
  if (res.status !== status) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function register(user) {
  const res = await http('POST', `${BFF}/auth/register`, { body: user });
  if (res.status !== 201 && res.status !== 409) expect(res, 201, `No se pudo registrar ${user.email}`);
  return expect(await http('POST', `${BFF}/auth/login`, { body: { email: user.email, password: user.password } }), 200, 'Login').accessToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const diner = await register(DINER);
const mine = expect(await http('GET', `${BFF}/reservations/mine?limit=1`, { token: diner }), 200, 'Mis reservas');
const missing = Math.max(0, COUNT - mine.total);
console.log(`${DINER.email} tiene ${mine.total} reservas. Creo ${missing} más.`);
if (missing === 0) process.exit(0);

const owner = await register({
  email: `perf-owner-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Perf Owner',
  password: 'Password123',
  role: 'RESTAURANT_OWNER',
});
const restaurantIds = [];
for (let n = 1; n <= RESTAURANT_COUNT; n++) {
  const created = await http('POST', `${RESTAURANTS}/restaurants`, {
    token: owner,
    body: {
      name: `Perf Reservas ${n}`,
      cuisine: 'Parrilla',
      // Mismo formato que perf/seed.mjs: cleanup.mjs exige nombre "Perf ..." Y esta dirección para borrarlo
      address: `Calle ${900 + n} 1234, Quilmes`,
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opens: '10:00', closes: '23:00' })),
      tables: [1, 2, 3, 4].map((number) => ({ number, capacity: 4 })),
    },
  });
  restaurantIds.push(expect(created, 201, 'No se pudo crear el restaurante').id);
}

const started = Date.now();
const offset = mine.total; // si se corta y se vuelve a correr, sigue con días nuevos en vez de pisar horarios tomados
for (let i = 0; i < missing; i++) {
  const n = offset + i;
  const day = new Date(Date.now() + (1 + Math.floor(n / RESTAURANT_COUNT)) * 86_400_000).toISOString().slice(0, 10);
  const created = await http('POST', `${BFF}/reservations`, {
    token: diner,
    body: { restaurantId: restaurantIds[n % RESTAURANT_COUNT], partySize: 2, startsAt: `${day}T20:00:00-03:00` },
  });
  const reservation = expect(created, 201, `No se pudo reservar (${day})`);

  const paid = await http('POST', `${BFF}/reservations/${reservation.id}/pay`, {
    token: diner,
    headers: { 'idempotency-key': randomUUID() },
    body: { token: 'tok_approved' },
  });
  expect(paid, 200, 'No se pudo pagar');

  // La confirmación llega por evento: hasta que llega, la reserva cuenta para el tope de pendientes
  for (let tries = 0; ; tries++) {
    const { body } = await http('GET', `${BFF}/reservations/${reservation.id}`, { token: diner });
    if (body?.status === 'CONFIRMED') break;
    if (tries > 50) throw new Error(`La reserva ${reservation.id} no se confirmó (estado ${body?.status})`);
    await sleep(200);
  }
  if ((i + 1) % 10 === 0 || i + 1 === missing) console.log(`  ${i + 1}/${missing} reservas pagadas`);
}
console.log(`Listo en ${Math.round((Date.now() - started) / 1000)} s.`);
