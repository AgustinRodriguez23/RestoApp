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

  // ------------------------------------------------------------------ 8
  // Panel del dueño: el nombre del cliente viaja en el JWT y queda guardado en la reserva
  if (!process.env.E2E_RESTAURANT_ID) {
    section('8. Panel del dueño: ver las reservas del local, marcar asistencia y cancelar');
    const day = freshDay();
    const created = (await reserve(slot(day, '21:00'))).body;
    if (created.status === 'PENDING_PAYMENT') {
      await pay(created.id, 'tok_approved');
      await waitStatus(created.id, 'CONFIRMED');
    }
    const ownerList = (token, query = '') => http('GET', `${BFF}/owner/restaurants/${restaurantId}/reservations?${query}`, { token });

    const mine = await http('GET', `${BFF}/owner/restaurants`, { token: owner });
    check('el dueño ve su restaurante en /owner/restaurants', mine.status === 200 && mine.body.some((r) => (r.id ?? r._id) === restaurantId), JSON.stringify(mine.body));
    check('un cliente no puede listar restaurantes de dueño (403)', (await http('GET', `${BFF}/owner/restaurants`, { token: customer })).status === 403);

    const listed = await ownerList(owner, `date=${day}`);
    const row = listed.body?.data?.find((x) => x.id === created.id);
    check('el dueño ve la reserva del día', listed.status === 200 && !!row, `${listed.status} ${JSON.stringify(listed.body)}`);
    check('la reserva trae el nombre del cliente (salió del JWT)', row?.customerName === 'E2E customer', JSON.stringify(row));
    check('el filtro por día excluye otras fechas', (await ownerList(owner, `date=${freshDay()}`)).body?.data?.length === 0);

    const stranger = await register('RESTAURANT_OWNER', 'stranger');
    const foreign = await ownerList(stranger);
    check('el dueño de OTRO restaurante no ve las reservas (403/404)', [403, 404].includes(foreign.status), String(foreign.status));
    check('un cliente no ve las reservas del local (403/404)', [403, 404].includes((await ownerList(customer)).status));

    const early = await http('PATCH', `${BFF}/owner/reservations/${created.id}/status`, { token: owner, body: { status: 'COMPLETED' } });
    check('marcar "asistió" antes de la hora da 400', early.status === 400, String(early.status));
    const bad = await http('PATCH', `${BFF}/owner/reservations/${created.id}/status`, { token: owner, body: { status: 'CANCELLED' } });
    check('por esta ruta no se puede poner CANCELLED (400)', bad.status === 400, String(bad.status));

    const cancelled = await http('POST', `${BFF}/reservations/${created.id}/cancel`, { token: owner });
    check('el dueño cancela la reserva futura', cancelled.status === 200 && cancelled.body.status === 'CANCELLED', JSON.stringify(cancelled.body));
    const afterCancel = await ownerList(owner, `date=${day}&status=CANCELLED`);
    check('aparece en el filtro "canceladas"', afterCancel.body?.data?.some((x) => x.id === created.id));
  }

  // ------------------------------------------------------------------ 9
  // Gestión de restaurantes del dueño (alta, edición, baja) a través del BFF
  if (!process.env.E2E_RESTAURANT_ID) {
    section('9. Gestión de restaurantes: crear, editar y eliminar desde el panel');
    const input = {
      name: `E2E Gestión ${RUN}`,
      cuisine: 'Pruebas',
      address: 'Calle Falsa 456, Quilmes',
      openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
      tables: [{ number: 1, capacity: 4 }, { number: 2, capacity: 2 }],
    };
    const created = await http('POST', `${BFF}/owner/restaurants`, { token: owner, body: input });
    const newId = created.body?.id ?? created.body?._id;
    check('el dueño crea un restaurante (201)', created.status === 201 && !!newId, `${created.status} ${JSON.stringify(created.body)}`);

    const mine = await http('GET', `${BFF}/owner/restaurants`, { token: owner });
    check('aparece en "mis restaurantes"', mine.body.some((r) => (r.id ?? r._id) === newId));
    check('y también en el listado público', (await http('GET', `${BFF}/restaurants?search=${encodeURIComponent(input.name)}`)).body.data.some((r) => (r.id ?? r._id) === newId));

    check('un cliente no puede crear restaurantes (403)', (await http('POST', `${BFF}/owner/restaurants`, { token: customer, body: input })).status === 403);
    check('sin mesas el BFF rechaza antes de molestar al servicio (400)', (await http('POST', `${BFF}/owner/restaurants`, { token: owner, body: { ...input, tables: [] } })).status === 400);
    check('mesas con número repetido: 400', (await http('PATCH', `${BFF}/owner/restaurants/${newId}`, { token: owner, body: { tables: [{ number: 1, capacity: 4 }, { number: 1, capacity: 2 }] } })).status === 400);

    const renamed = `${input.name} (editado)`;
    const patched = await http('PATCH', `${BFF}/owner/restaurants/${newId}`, { token: owner, body: { name: renamed, tables: [{ number: 7, capacity: 6 }] } });
    check('editar nombre y mesas responde 200', patched.status === 200, `${patched.status} ${JSON.stringify(patched.body)}`);
    const seen = (await http('GET', `${BFF}/restaurants/${newId}/overview`)).body.restaurant;
    check('el detalle público muestra el cambio enseguida (el caché se invalida)', seen?.name === renamed && seen?.tables?.[0]?.number === 7, JSON.stringify(seen));

    const stranger = await register('RESTAURANT_OWNER', 'stranger2');
    check('otro dueño no puede modificarlo (403)', (await http('PATCH', `${BFF}/owner/restaurants/${newId}`, { token: stranger, body: { name: 'Robado!!' } })).status === 403);
    check('ni eliminarlo (403)', (await http('DELETE', `${BFF}/owner/restaurants/${newId}`, { token: stranger })).status === 403);

    const removed = await http('DELETE', `${BFF}/owner/restaurants/${newId}`, { token: owner });
    check('el dueño lo elimina (204)', removed.status === 204, String(removed.status));
    check('el detalle público ya no existe (404)', (await http('GET', `${BFF}/restaurants/${newId}/overview`)).status === 404);
    check('y no figura en "mis restaurantes"', !(await http('GET', `${BFF}/owner/restaurants`, { token: owner })).body.some((r) => (r.id ?? r._id) === newId));
  }

  // ------------------------------------------------------------------ 10
  // Carta del dueño a través del BFF: alta, pausa, edición y baja, con la carta pública siempre al día
  if (!process.env.E2E_RESTAURANT_ID) {
    section('10. Carta del dueño: agregar, pausar, editar y quitar platos');
    const base = `${BFF}/owner/restaurants/${restaurantId}`;
    const publicMenu = async () => (await http('GET', `${BFF}/restaurants/${restaurantId}/overview`)).body.menu ?? [];
    const names = (menu) => menu.flatMap((c) => c.items.map((i) => i.name));
    const ownerMenu = async () => (await http('GET', `${base}/menu`, { token: owner })).body ?? [];
    const dish = { category: 'Entradas', name: `Provoleta ${RUN}`, priceCents: 850050, allergens: ['MILK'], variants: [{ name: 'Con jamón', priceDeltaCents: 120000 }] };

    const added = await http('POST', `${base}/menu-items`, { token: owner, body: dish });
    const itemId = added.body?.id ?? added.body?._id;
    check('el dueño agrega un plato (201)', added.status === 201 && !!itemId, `${added.status} ${JSON.stringify(added.body)}`);
    check('un alérgeno inventado se rechaza (400)', (await http('POST', `${base}/menu-items`, { token: owner, body: { ...dish, allergens: ['LACTOSE'] } })).status === 400);
    check('un precio con decimales se rechaza (400): viaja en centavos enteros', (await http('POST', `${base}/menu-items`, { token: owner, body: { ...dish, priceCents: 100.5 } })).status === 400);
    check('un cliente no puede agregar platos (403)', (await http('POST', `${base}/menu-items`, { token: customer, body: dish })).status === 403);

    check('el plato aparece en la carta del dueño', names(await ownerMenu()).includes(dish.name));
    check('y en la carta pública', names(await publicMenu()).includes(dish.name));

    const paused = await http('PATCH', `${base}/menu-items/${itemId}`, { token: owner, body: { available: false } });
    check('pausarlo responde 200', paused.status === 200, String(paused.status));
    check('pausado: desaparece de la carta pública', !names(await publicMenu()).includes(dish.name));
    const stillThere = (await ownerMenu()).flatMap((c) => c.items).find((i) => i.name === dish.name);
    check('pero el dueño lo sigue viendo, marcado como no disponible', stillThere?.available === false, JSON.stringify(stillThere));

    await http('PATCH', `${base}/menu-items/${itemId}`, { token: owner, body: { available: true, priceCents: 900000 } });
    const back = (await publicMenu()).flatMap((c) => c.items).find((i) => i.name === dish.name);
    check('al reactivarlo y cambiar el precio, la carta pública lo muestra con el precio nuevo', back?.priceCents === 900000, JSON.stringify(back));

    const stranger = await register('RESTAURANT_OWNER', 'stranger3');
    check('otro dueño no puede modificar sus platos (403)', (await http('PATCH', `${base}/menu-items/${itemId}`, { token: stranger, body: { priceCents: 1 } })).status === 403);
    check('ni quitarlos (403)', (await http('DELETE', `${base}/menu-items/${itemId}`, { token: stranger })).status === 403);

    check('el dueño quita el plato (204)', (await http('DELETE', `${base}/menu-items/${itemId}`, { token: owner })).status === 204);
    check('ya no está en ninguna carta', !names(await ownerMenu()).includes(dish.name) && !names(await publicMenu()).includes(dish.name));
    check('quitarlo de nuevo da 404', (await http('DELETE', `${base}/menu-items/${itemId}`, { token: owner })).status === 404);
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
