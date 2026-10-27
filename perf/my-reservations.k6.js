/**
 * Prueba de carga de "Mis reservas": el pedido del BFF que más llamadas internas dispara.
 *
 *   80 %  GET /reservations/mine?limit=50   (lo que pide el front)  → reservas + nombre de cada restaurante + pago de cada una
 *   20 %  GET /me/overview                   → perfil + próximas 5 + las que esperan el pago
 *
 * Todos los pedidos son del mismo cliente (perf-diner, cargado con perf/seed-reservations.mjs: 30 reservas pagadas
 * en 3 restaurantes). Es el peor caso realista de la pantalla, que muestra hasta 50.
 *
 * Mismo modelo que read-heavy.k6.js: carga ABIERTA (RATE pedidos por segundo pase lo que pase), con calentamiento
 * que no se mide. Ojo: cada pedido de "mine" son decenas de llamadas internas, así que RATE va mucho más bajo que en
 * la prueba de lectura:
 *
 *   RATE=20 docker compose --profile perf run --rm k6 run my-reservations.k6.js --summary-export=results/mine-before.json
 *
 * Variables: BASE_URL  RATE  DURATION (30s)  WARMUP (10s)
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const RATE = Number(__ENV.RATE || 20);
const DURATION = __ENV.DURATION || '30s';
const WARMUP = __ENV.WARMUP || '10s';

const scenario = (phase, startTime, duration) => ({
  executor: 'constant-arrival-rate',
  rate: RATE,
  timeUnit: '1s',
  duration,
  startTime,
  preAllocatedVUs: 20,
  maxVUs: 200,
  exec: 'visit',
  tags: { phase },
});

export const options = {
  scenarios: {
    warmup: scenario('warmup', '0s', WARMUP),
    measure: scenario('measure', WARMUP, DURATION),
  },
  // Igual que en read-heavy: los umbrales hacen que k6 exporte las métricas por endpoint (compare.mjs las lee)
  thresholds: {
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'http_reqs{phase:measure}': ['count>0'],
    'http_req_duration{phase:measure}': ['p(95)<2000'],
    'http_req_duration{phase:measure,endpoint:mine}': ['p(95)<2000'],
    'http_req_duration{phase:measure,endpoint:me-overview}': ['p(95)<2000'],
  },
};

/** Un solo login (el BFF limita los intentos por IP) y el token se comparte entre todos los usuarios virtuales. */
export function setup() {
  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email: 'perf-diner@example.com', password: 'Password123' }), {
    headers: { 'content-type': 'application/json' },
  });
  if (login.status !== 200) throw new Error(`Login de perf-diner: ${login.status}. ¿Corriste node perf/seed-reservations.mjs?`);
  const token = login.json('accessToken');

  const mine = http.get(`${BASE}/reservations/mine?limit=1`, { headers: { authorization: `Bearer ${token}` } });
  const total = mine.json('total');
  if (total < 20) throw new Error(`perf-diner tiene ${total} reservas: corré node perf/seed-reservations.mjs`);
  console.log(`perf-diner tiene ${total} reservas. Carga: ${RATE} pedidos/s, ${WARMUP} de calentamiento + ${DURATION} medidos.`);
  return { token };
}

export function visit({ token }) {
  const params = (endpoint) => ({ headers: { authorization: `Bearer ${token}` }, tags: { endpoint } });
  const res =
    Math.random() < 0.8
      ? http.get(`${BASE}/reservations/mine?limit=50`, params('mine'))
      : http.get(`${BASE}/me/overview`, params('me-overview'));
  check(res, { 'responde 200': (r) => r.status === 200 });
}
