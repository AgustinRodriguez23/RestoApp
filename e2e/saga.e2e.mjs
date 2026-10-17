/**
 * Prueba de punta a punta de la saga de la seña, contra el sistema COMPLETO en marcha
 * (BFF → reservations-service ⇄ RabbitMQ ⇄ payments-service → pasarela simulada).
 *
 * Cómo correrla:
 *   1) npm run up                    (o los servicios con `npm run dev:*` + `npm run infra:up`)
 *   2) npm run test:e2e
 *
 * Variables opcionales:
 *   BFF_URL            (http://localhost:3000)
 *   RESTAURANTS_URL    (http://localhost:3002)  solo para crear el restaurante de prueba
 *   E2E_RESTAURANT_ID  usar un restaurante existente en vez de crear uno
 *   E2E_EXPIRY=1       además prueba el vencimiento: tarda ~PAYMENT_WINDOW_MINUTES + 30 s (con la ventana de 15 min
 *                      por defecto son 15 min; para probarlo rápido levantá reservations con PAYMENT_WINDOW_MINUTES=1)
 *
 * No necesita librerías: usa fetch (Node 20+). Cada escenario usa un horario distinto, así que se puede repetir.
 */
import { randomUUID } from 'node:crypto';

const BFF = (process.env.BFF_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const RESTAURANTS = (process.env.RESTAURANTS_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const RUN = Math.random().toString(36).slice(2, 8);

let passed = 0;
let failed = 0;
const log = (msg) => console.log(msg);
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    log(`  ✓ ${name}`);
  } else {
    failed++;
    log(`  ✗ ${name} ${detail}`);
  }
}

async function http(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function waitFor(description, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout esperando: ${description}`);
}

const section = (title) => log(`\n${title}`);

// ------------------------------------------------------------------ preparación
async function register(role, label) {
  const email = `e2e-${label}-${RUN}@example.com`;
  const password = 'Password123';
  const reg = await http('POST', `${BFF}/auth/register`, { body: { email, name: `E2E ${label}`, password, role } });
  if (reg.status !== 201) throw new Error(`No se pudo registrar ${label}: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await http('POST', `${BFF}/auth/login`, { body: { email, password } });
  return login.body.accessToken;
}

async function ensureRestaurant(ownerToken) {
  if (process.env.E2E_RESTAURANT_ID) return process.env.E2E_RESTAURANT_ID;
  const res = await http('POST', `${RESTAURANTS}/restaurants`, {
    token: ownerToken,
    body: {
      name: `E2E Resto ${RUN}`,
      cuisine: 'Pruebas',
      address: 'Calle Falsa 123, Quilmes',
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opens: '10:00', closes: '23:00' })),
      tables: [{ number: 1, capacity: 4 }],
    },
  });
  if (res.status !== 201) throw new Error(`No se pudo crear el restaurante: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id ?? res.body._id;
}

// Cada escenario usa un día distinto (entre 10 y 80 días adelante) para no pisarse entre corridas
const usedDays = new Set();
function freshDay() {
  for (;;) {
    const offset = 10 + Math.floor(Math.random() * 70);
    if (usedDays.has(offset)) continue;
    usedDays.add(offset);
    return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  }
}
const slot = (day, hhmm = '20:00') => `${day}T${hhmm}:00-03:00`;

async function main() {
  log(`Saga de la seña — BFF en ${BFF}`);
  const health = await http('GET', `${BFF}/health`);
  if (health.status !== 200) throw new Error(`El BFF no responde en ${BFF}`);
  log(`Estado: ${JSON.stringify(health.body.upstreams)}`);

  const owner = await register('RESTAURANT_OWNER', 'owner');
  const customer = await register('CUSTOMER', 'customer');
  const restaurantId = await ensureRestaurant(owner);

  const reserve = (startsAt, extra = {}, token = customer, correlationId = randomUUID()) =>
    http('POST', `${BFF}/reservations`, { token, headers: { 'x-correlation-id': correlationId }, body: { restaurantId, partySize: 3, startsAt, ...extra } });
  const reservation = async (id, token = customer) => (await http('GET', `${BFF}/reservations/${id}`, { token })).body;
  const payment = async (id, token = customer) => (await http('GET', `${BFF}/reservations/${id}/payment`, { token })).body;
  const pay = (id, tok, key = randomUUID(), token = customer) =>
    http('POST', `${BFF}/reservations/${id}/pay`, { token, headers: { 'idempotency-key': key }, body: { token: tok } });
  const waitStatus = (id, status, token = customer) => waitFor(`reserva ${id} → ${status}`, async () => (await reservation(id, token)).status === status);

  // ------------------------------------------------------------------ 0
  // Contrato entre servicios: el front depende de la FORMA de lo que devuelve el BFF, y los tests unitarios
  // de cada pieza simulan a las otras. Esto es lo único que prueba que coinciden de verdad.
  // También comprueba que el caché (Fase 8) nunca devuelve datos viejos tras una modificación.
  if (!process.env.E2E_RESTAURANT_ID) {
    section('0. La carta y el caché: forma de la respuesta y datos siempre frescos');
    const overview = () => http('GET', `${BFF}/restaurants/${restaurantId}/overview`);
    const addDish = (name) =>
      http('POST', `${RESTAURANTS}/restaurants/${restaurantId}/menu-items`, {
        token: owner,
        body: { category: 'Postres', name, priceCents: 450000, allergens: ['MILK'] },
      });

    const firstDish = await addDish('Flan casero');
    check('agregar un plato responde 201', firstDish.status === 201, `${firstDish.status} ${JSON.stringify(firstDish.body)}`);
    const first = await overview();
    const menu = first.body.menu;
    check(
      'la carta llega AGRUPADA por categoría: [{ category, items: [...] }] (así la lee el front)',
      Array.isArray(menu) && menu[0]?.category === 'Postres' && Array.isArray(menu[0]?.items) && menu[0].items[0]?.name === 'Flan casero',
      JSON.stringify(menu),
    );
    check('cada plato trae allergens como lista (el front la recorre)', Array.isArray(menu?.[0]?.items?.[0]?.allergens));

    await overview(); // segunda lectura: sale del caché si está activo
    await addDish('Panqueque con dulce de leche');
    const afterAdd = JSON.stringify((await overview()).body.menu);
    check('tras agregar un plato, la carta ya lo incluye (el caché se invalida)', afterAdd.includes('Panqueque con dulce de leche'), afterAdd);

    const renamed = `E2E Resto ${RUN} (renombrado)`;
    const patch = await http('PATCH', `${RESTAURANTS}/restaurants/${restaurantId}`, { token: owner, body: { name: renamed } });
    check('modificar el restaurante responde 200', patch.status === 200, String(patch.status));
    check('tras modificarlo, el BFF muestra el nombre nuevo enseguida (sin esperar el TTL)', (await overview()).body.restaurant?.name === renamed);
  }

  // ------------------------------------------------------------------ 1
  section('1. Camino feliz: reservar → pagar → reserva confirmada');
  {
    const day = freshDay();
    const correlationId = `e2e-${RUN}-happy`;
    const created = await reserve(slot(day), {}, customer, correlationId);
    check('crear la reserva responde 201', created.status === 201, JSON.stringify(created.body));
    const r = created.body;
    if (!(r.depositCents > 0)) {
      log('  (!) Este entorno no cobra seña (DEPOSIT_PER_PERSON_CENTS=0): se omite el resto de la saga.');
      return;
    }
    check('nace PENDING_PAYMENT con la seña y hora límite', r.status === 'PENDING_PAYMENT' && r.depositCents > 0 && !!r.expiresAt);

    const second = await reserve(slot(day), {}, customer);
    check('la mesa queda retenida: otra reserva en el mismo horario da 409', second.status === 409, String(second.status));

    const key = randomUUID();
    const paid = await pay(r.id, 'tok_approved', key);
    check('pagar con tok_approved responde 200 SUCCEEDED', paid.status === 200 && paid.body.status === 'SUCCEEDED', JSON.stringify(paid.body));

    await waitStatus(r.id, 'CONFIRMED');
    check('la reserva pasa a CONFIRMED (evento payment.succeeded)', true);

    const replay = await pay(r.id, 'tok_approved', key);
    check('repetir el pago con la MISMA Idempotency-Key devuelve lo mismo (sin cobrar de nuevo)', replay.status === 200 && replay.body.id === paid.body.id && replay.headers.get('idempotent-replayed') === 'true');

    const again = await pay(r.id, 'tok_approved');
    check('pagar otra vez con otra clave da 409 (ya está pagado)', again.status === 409, String(again.status));

    const mine = await http('GET', `${BFF}/reservations/mine?status=CONFIRMED`, { token: customer });
    const found = mine.body.data.find((x) => x.id === r.id);
    check('en "mis reservas" aparece con su pago SUCCEEDED', found?.payment?.status === 'SUCCEEDED');
    log(`  → Para seguir esta saga en Grafana buscá el correlationId: ${correlationId}`);
  }

  // ------------------------------------------------------------------ 2
  section('2. Pago rechazado: la reserva se cancela y la mesa se libera');
  {
    const day = freshDay();
    const r = (await reserve(slot(day))).body;
    const paid = await pay(r.id, 'tok_declined');
    check('tok_declined responde 200 con el pago FAILED', paid.status === 200 && paid.body.status === 'FAILED' && paid.body.failureReason === 'card_declined');

    await waitStatus(r.id, 'CANCELLED');
    check('la reserva pasa a CANCELLED', true);
    const retry = await reserve(slot(day));
    check('la mesa quedó libre: se puede volver a reservar el mismo horario', retry.status === 201, String(retry.status));
  }

  // ------------------------------------------------------------------ 3
  section('3. Pasarela asíncrona: el resultado llega por webhook');
  {
    const day = freshDay();
    const r = (await reserve(slot(day))).body;
    const paid = await pay(r.id, 'tok_slow_duplicate');
    check('tok_slow_duplicate responde 202 PROCESSING', paid.status === 202 && paid.body.status === 'PROCESSING', JSON.stringify(paid.body));

    await waitStatus(r.id, 'CONFIRMED');
    check('el webhook (enviado dos veces) confirma la reserva', true);
    check('el pago quedó SUCCEEDED', (await payment(r.id)).status === 'SUCCEEDED');
  }

  // ------------------------------------------------------------------ 4
  section('4. La pasarela se cae: no se cobra, se puede reintentar');
  {
    const day = freshDay();
    const r = (await reserve(slot(day))).body;
    const key = randomUUID();
    const down = await pay(r.id, 'tok_error', key);
    check('tok_error responde 502 y no cobra', down.status === 502, String(down.status));
    check('el pago sigue PENDING', (await payment(r.id)).status === 'PENDING');
    const retry = await pay(r.id, 'tok_approved', key);
    check('reintentar con la misma clave funciona', retry.status === 200 && retry.body.status === 'SUCCEEDED');
    await waitStatus(r.id, 'CONFIRMED');
  }

  // ------------------------------------------------------------------ 5
  section('5. Cancelar con anticipación devuelve la seña');
  {
    const day = freshDay();
    const r = (await reserve(slot(day))).body;
    await pay(r.id, 'tok_approved');
    await waitStatus(r.id, 'CONFIRMED');

    const cancelled = await http('POST', `${BFF}/reservations/${r.id}/cancel`, { token: customer });
    check('cancelar responde 200', cancelled.status === 200 && cancelled.body.status === 'CANCELLED');
    await waitFor('pago REFUNDED', async () => (await payment(r.id)).status === 'REFUNDED');
    check('el pago pasa a REFUNDED (compensación)', true);
  }

  // ------------------------------------------------------------------ 6
  section('6. Un cliente no puede tocar el pago de otro');
  {
    const day = freshDay();
    const r = (await reserve(slot(day))).body;
    const other = await register('CUSTOMER', 'other');
    check('otro usuario no ve el pago (404)', (await http('GET', `${BFF}/reservations/${r.id}/payment`, { token: other })).status === 404);
    check('otro usuario no puede pagar (404)', (await pay(r.id, 'tok_approved', randomUUID(), other)).status === 404);
    check('sin Idempotency-Key el BFF rechaza (400)', (await http('POST', `${BFF}/reservations/${r.id}/pay`, { token: customer, body: { token: 'tok_approved' } })).status === 400);
  }

  // ------------------------------------------------------------------ 7
  if (process.env.E2E_EXPIRY === '1') {
    section('7. Vencimiento: si no paga a tiempo, la mesa se libera');
    const day = freshDay();
    const r = (await reserve(slot(day))).body;
    const until = new Date(r.expiresAt).getTime() - Date.now();
    log(`  (esperando el vencimiento: ~${Math.ceil(until / 1000)} s + el ciclo del vencimiento automático)`);
    await waitFor('reserva EXPIRED', async () => (await reservation(r.id)).status === 'EXPIRED', until + 90_000);
    check('la reserva pasa a EXPIRED', true);
    await waitFor('pago EXPIRED', async () => (await payment(r.id)).status === 'EXPIRED');
    check('el pago pendiente pasa a EXPIRED', true);
    check('la mesa se liberó', (await reserve(slot(day))).status === 201);
    const late = await pay(r.id, 'tok_approved');
    check('pagar después de vencer da 409', late.status === 409, String(late.status));
  } else {
    log('\n(El escenario de vencimiento se omite; activalo con E2E_EXPIRY=1)');
  }
}

main()
  .then(() => {
    log(`\n${passed} verificaciones correctas, ${failed} fallidas`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    log(`\n✗ ${error.message}`);
    process.exit(1);
  });
