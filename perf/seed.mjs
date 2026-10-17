/**
 * Carga datos de prueba para medir: N restaurantes con su carta (por defecto 150 restaurantes × 30 platos).
 * Sin datos "de verdad", MongoDB responde tan rápido que no hay nada que acelerar y la comparación no dice nada.
 *
 * Uso (con el sistema levantado):   node perf/seed.mjs
 * Variables: BFF_URL (http://localhost:3000)  RESTAURANTS_URL (http://localhost:3002)  COUNT (150)  ITEMS (30)
 *
 * Se puede repetir sin problema: cuenta los restaurantes "Perf" que ya existen y solo crea los que faltan.
 * No usa librerías (Node 20+).
 */
const BFF = (process.env.BFF_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const RESTAURANTS = (process.env.RESTAURANTS_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const COUNT = Number(process.env.COUNT ?? 150);
const ITEMS = Number(process.env.ITEMS ?? 30);

const CUISINES = ['Parrilla', 'Pizza', 'Pastas', 'Sushi', 'Vegano'];
const CATEGORIES = ['Entradas', 'Platos principales', 'Guarniciones', 'Postres', 'Bebidas'];
const NAMES = ['La Casa de', 'El Rincón de', 'Don', 'Sabores de', 'Cantina', 'Parrilla', 'Bodegón', 'Mar y Sol'];

async function http(method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function ownerToken() {
  const email = `perf-owner-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'Password123';
  const reg = await http('POST', `${BFF}/auth/register`, { body: { email, name: 'Perf Owner', password, role: 'RESTAURANT_OWNER' } });
  if (reg.status !== 201) throw new Error(`No se pudo registrar el dueño: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await http('POST', `${BFF}/auth/login`, { body: { email, password } });
  return login.body.accessToken;
}

const existing = await http('GET', `${RESTAURANTS}/restaurants?search=Perf&limit=1`);
if (existing.status !== 200) throw new Error(`restaurants-service no responde en ${RESTAURANTS} (${existing.status})`);
const already = existing.body.total;
const missing = Math.max(0, COUNT - already);
console.log(`Ya hay ${already} restaurantes "Perf". Creo ${missing} más (cada uno con ${ITEMS} platos).`);
if (missing === 0) process.exit(0);

const token = await ownerToken();
const started = Date.now();

for (let i = 0; i < missing; i++) {
  const n = already + i + 1;
  const created = await http('POST', `${RESTAURANTS}/restaurants`, {
    token,
    body: {
      name: `Perf ${NAMES[n % NAMES.length]} ${n}`,
      cuisine: CUISINES[n % CUISINES.length],
      address: `Calle ${n} 1234, Quilmes`,
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opens: '10:00', closes: '23:00' })),
      tables: [1, 2, 3, 4, 5, 6].map((number) => ({ number, capacity: 2 + (number % 4) * 2 })),
    },
  });
  if (created.status !== 201) throw new Error(`No se pudo crear el restaurante ${n}: ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.id;

  for (let j = 0; j < ITEMS; j++) {
    const item = await http('POST', `${RESTAURANTS}/restaurants/${id}/menu-items`, {
      token,
      body: {
        category: CATEGORIES[j % CATEGORIES.length],
        name: `Plato ${j + 1} del restaurante ${n}`,
        description: 'Plato de prueba para medir rendimiento',
        priceCents: 500000 + j * 15000,
      },
    });
    if (item.status !== 201) throw new Error(`No se pudo crear un plato: ${item.status} ${JSON.stringify(item.body)}`);
  }
  if ((i + 1) % 25 === 0 || i + 1 === missing) console.log(`  ${i + 1}/${missing} restaurantes creados`);
}
console.log(`Listo en ${Math.round((Date.now() - started) / 1000)} s.`);
