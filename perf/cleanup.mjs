/**
 * Borra datos de prueba de las bases locales.
 *
 *   node perf/cleanup.mjs                lo que creó perf/seed.mjs: restaurantes "Perf", sus cartas y los usuarios perf-owner-*
 *   node perf/cleanup.mjs --e2e          lo que creó e2e/saga.e2e.mjs: los usuarios e2e-* y todo lo suyo (restaurantes,
 *                                        reservas, pagos y notificaciones)
 *   Sin --yes solo muestra qué borraría. Con --yes borra.
 * Variables: RESTAURANTS_MONGO_DB (restaurants_db)  NOTIFICATIONS_MONGO_DB (notifications_db)
 *
 * Va directo a las bases (con `docker compose exec`) y no por la API porque el seed y el e2e crean dueños nuevos en cada
 * corrida y no guardan sus contraseñas: sin sus tokens, DELETE /restaurants/:id no se puede llamar.
 * Por eso hace a mano lo mismo que el servicio al borrar un restaurante: el restaurante, su carta y la invalidación del caché.
 * No usa librerías (Node 20+).
 */
import { execFileSync } from 'node:child_process';

const CONFIRM = process.argv.includes('--yes');
const E2E = process.argv.includes('--e2e');
const RESTAURANTS_DB = process.env.RESTAURANTS_MONGO_DB ?? 'restaurants_db';
const NOTIFICATIONS_DB = process.env.NOTIFICATIONS_MONGO_DB ?? 'notifications_db';

// Lo que crea cada script y nada más. Se exigen nombre y dirección para no tocar un restaurante real que se llame parecido.
const TARGETS = {
  perf: {
    label: 'del seed',
    restaurants: { name: { $regex: '^Perf ' }, address: { $regex: '^Calle \\d+ 1234, Quilmes$' } },
    users: "email LIKE 'perf-owner-%@example.com'",
  },
  e2e: {
    label: 'del e2e',
    restaurants: { name: { $regex: '^E2E Resto ' }, address: 'Calle Falsa 123, Quilmes' },
    users: "email LIKE 'e2e-%@example.com'",
  },
};
const target = E2E ? TARGETS.e2e : TARGETS.perf;

/** Corre un comando dentro de un contenedor del compose. Las credenciales salen del entorno del propio contenedor. */
function exec(service, script, ...args) {
  return execFileSync('docker', ['compose', 'exec', '-T', service, 'sh', '-c', script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function mongo(service, db, code) {
  const out = exec(
    service,
    'exec mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --quiet "$0" --eval "$1"',
    db,
    code,
  );
  return JSON.parse(out);
}

function psql(service, sql) {
  return exec(service, 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "$0"', sql);
}

/** Filas de una columna, una por línea. */
function psqlColumn(service, sql) {
  const out = psql(service, sql);
  return out ? out.split('\n') : [];
}

/** Igual que `psql`, pero si el contenedor no está levantado devuelve null en vez de cortar. */
function psqlIfUp(service, sql) {
  try {
    return psql(service, sql);
  } catch {
    return null;
  }
}

/** Lista para un IN de SQL. Los ids vienen de las bases (uuid u ObjectId), pero igual se validan antes de pegarlos en la consulta. */
function sqlList(ids) {
  if (!ids.every((id) => /^[\w-]+$/.test(id))) throw new Error('Id inesperado: no lo pego en una consulta SQL');
  return ids.length ? ids.map((id) => `'${id}'`).join(',') : 'NULL';
}

function fail(message, err) {
  console.error(message);
  if (err) console.error(err.stderr?.toString().trim() || err.message);
  process.exit(1);
}

// --- 1. Qué hay para borrar -------------------------------------------------------------------------

// En modo e2e los usuarios son la referencia de todo lo demás, así que sin auth no se sigue.
// En modo perf solo hacen falta para borrar al dueño, así que si auth no está se avisa y se sigue.
let userIds = null;
try {
  userIds = psqlColumn('postgres-auth', `SELECT id FROM users WHERE ${target.users}`);
} catch (err) {
  if (E2E) fail('No pude consultar postgres-auth, y sin los usuarios e2e no sé qué es de prueba. ¿Está levantado? (npm run infra:up)', err);
}

let found;
try {
  const filter = E2E ? { ...target.restaurants, ownerId: { $in: userIds } } : target.restaurants;
  found = mongo(
    'mongo-restaurants',
    RESTAURANTS_DB,
    `
    const ids = db.restaurants.find(${JSON.stringify(filter)}, { _id: 1 }).toArray().map((r) => r._id);
    print(JSON.stringify({
      ids: ids.map((id) => id.toHexString()),
      menuItems: db.menuitems.countDocuments({ restaurantId: { $in: ids } }),
    }));
  `,
  );
} catch (err) {
  fail('No pude consultar MongoDB. ¿Está levantado mongo-restaurants? (npm run infra:up)', err);
}
const restaurantIds = found.ids;

console.log(`Restaurantes ${target.label}: ${restaurantIds.length} (con ${found.menuItems} platos en total)`);
console.log(`Usuarios ${target.label}: ${userIds?.length ?? '? (postgres-auth no está levantado: no se van a borrar)'}`);

// Una reserva vigente (retiene la mesa y es a futuro) de alguien que NO es de prueba quedaría sin restaurante:
// ni el cliente podría ir ni el dueño gestionarla. Las pasadas o liberadas quedan como historial (el BFF las muestra sin nombre).
// En modo e2e las reservas de los propios usuarios de prueba se borran, así que no cuentan.
let reservationIds = [];
if (restaurantIds.length > 0 || E2E) {
  const notTest = E2E ? ` AND customer_id NOT IN (${sqlList(userIds)})` : '';
  const counts = psqlIfUp(
    'postgres-reservations',
    `SELECT count(*) FILTER (WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED') AND starts_at > now()) || ' ' || count(*)
       FROM reservations WHERE restaurant_id IN (${sqlList(restaurantIds)})${notTest}`,
  );
  if (counts === null) fail('postgres-reservations no está levantado: no puedo comprobar que no haya reservas vigentes. No borro nada.');
  const [active, kept] = counts.split(' ').map(Number);
  if (active > 0) fail(`Hay ${active} reserva(s) vigente(s) de clientes reales en esos restaurantes. No borro nada: quedarían sin restaurante.`);
  if (kept > 0) console.log(`Reservas pasadas o canceladas de clientes reales: ${kept} (quedan como historial, sin nombre de restaurante)`);

  if (E2E) {
    reservationIds = psqlColumn('postgres-reservations', `SELECT id FROM reservations WHERE customer_id IN (${sqlList(userIds)})`);
  }
}

// En modo e2e también se borra lo que dejaron las reservas en payments y notifications
let paymentsWhere = '';
let notificationsCount = 0;
if (E2E) {
  paymentsWhere = `reservation_id IN (${sqlList(reservationIds)}) OR customer_id IN (${sqlList(userIds)})`;
  try {
    const counts = psql(
      'postgres-payments',
      `SELECT (SELECT count(*) FROM payments WHERE ${paymentsWhere}) || ' ' ||
              (SELECT count(*) FROM idempotency_keys WHERE scope IN (${sqlList(userIds)}))`,
    );
    const [payments, keys] = counts.split(' ');
    notificationsCount = mongo(
      'mongo-notifications',
      NOTIFICATIONS_DB,
      `print(db.notifications.countDocuments({ userId: { $in: ${JSON.stringify(userIds)} } }))`,
    );
    console.log(`Reservas: ${reservationIds.length}`);
    console.log(`Pagos: ${payments} (y ${keys} claves de idempotencia)`);
    console.log(`Notificaciones: ${notificationsCount}`);
  } catch (err) {
    fail('No pude consultar postgres-payments o mongo-notifications. ¿Está todo levantado? (npm run infra:up)', err);
  }
}

if (restaurantIds.length === 0 && !userIds?.length) {
  console.log('No hay nada para borrar.');
  process.exit(0);
}
if (!CONFIRM) {
  console.log(`\nNo se borró nada. Para borrar: node perf/cleanup.mjs${E2E ? ' --e2e' : ''} --yes`);
  process.exit(0);
}

// --- 2. Borrar ----------------------------------------------------------------------------------------
// No hay claves foráneas entre bases (cada servicio tiene la suya), así que el orden no rompe nada.
// Se borra de "afuera hacia adentro" para que, si algo corta a la mitad, lo que quede siga siendo encontrable con --e2e.

if (E2E) {
  const notifications = mongo(
    'mongo-notifications',
    NOTIFICATIONS_DB,
    `print(db.notifications.deleteMany({ userId: { $in: ${JSON.stringify(userIds)} } }).deletedCount)`,
  );
  const payments = psql('postgres-payments', `WITH d AS (DELETE FROM payments WHERE ${paymentsWhere} RETURNING 1) SELECT count(*) FROM d`);
  psql('postgres-payments', `DELETE FROM idempotency_keys WHERE scope IN (${sqlList(userIds)})`);
  const reservations = psql(
    'postgres-reservations',
    `WITH d AS (DELETE FROM reservations WHERE id IN (${sqlList(reservationIds)}) RETURNING 1) SELECT count(*) FROM d`,
  );
  console.log(`Borradas: ${notifications} notificaciones, ${payments} pagos y ${reservations} reservas.`);
}

const deleted = mongo(
  'mongo-restaurants',
  RESTAURANTS_DB,
  `
  const ids = ${JSON.stringify(restaurantIds)}.map((id) => ObjectId(id));
  const menu = db.menuitems.deleteMany({ restaurantId: { $in: ids } }).deletedCount;
  const restaurants = db.restaurants.deleteMany({ _id: { $in: ids } }).deletedCount;
  // Un usuario de prueba puede haber creado algo a mano: se borra solo si ya no le queda ningún restaurante
  const ownersInUse = db.restaurants.distinct('ownerId');
  print(JSON.stringify({ menu, restaurants, ownersInUse }));
`,
);
console.log(`Borrados: ${deleted.restaurants} restaurantes y ${deleted.menu} platos.`);

if (userIds?.length) {
  const keep = deleted.ownersInUse.length ? ` AND id::text NOT IN (${sqlList(deleted.ownersInUse)})` : '';
  const removed = psql('postgres-auth', `WITH d AS (DELETE FROM users WHERE ${target.users}${keep} RETURNING 1) SELECT count(*) FROM d`);
  console.log(`Borrados: ${removed} usuarios.`);
}

// Lo mismo que hace el servicio después de escribir: subir la versión deja inalcanzable todo lo cacheado
try {
  exec('redis', 'exec redis-cli INCR restaurants:version');
  console.log('Caché invalidado.');
} catch {
  console.log('Redis no está levantado: no hay caché que invalidar.');
}
