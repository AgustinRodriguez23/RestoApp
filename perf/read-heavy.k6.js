/**
 * Prueba de carga de LECTURA (Fase 8): lo que hace la gente que navega la app, sin escribir nada.
 *
 *   45 %  listado de restaurantes (páginas 1-5, a veces filtrado por cocina)   → cacheable
 *   45 %  pantalla de un restaurante (GET /restaurants/:id/overview)            → cacheable (detalle + carta)
 *   10 %  búsqueda por texto                                                    → NO cacheable: sirve de "control"
 *
 * Modelo de carga ABIERTO: llegan RATE pedidos por segundo pase lo que pase (como usuarios reales, que no
 * esperan a que el servidor termine con el anterior). Así, si el sistema se atrasa, se ve en la latencia
 * en vez de que la prueba "se frene sola" y esconda el problema.
 *
 * Variables (todas opcionales):
 *   BASE_URL   http://localhost:3000   (dentro de docker compose: http://web-bff:3000)
 *   RATE       100                     pedidos por segundo
 *   DURATION   30s                     duración de la medición
 *   WARMUP     10s                     calentamiento previo (JIT de Node, conexiones, caché); NO se mide
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '30s';
const WARMUP = __ENV.WARMUP || '10s';

const CUISINES = [null, null, 'Parrilla', 'Pizza', 'Pastas', 'Sushi', 'Vegano'];
const SEARCH_TERMS = ['perf', 'resto', 'la', 'el', 'casa', 'don', 'mar', 'sol'];

const scenario = (phase, startTime, duration) => ({
  executor: 'constant-arrival-rate',
  rate: RATE,
  timeUnit: '1s',
  duration,
  startTime,
  preAllocatedVUs: 50,
  maxVUs: 400,
  exec: 'browse',
  tags: { phase },
});

export const options = {
  scenarios: {
    warmup: scenario('warmup', '0s', WARMUP),
    measure: scenario('measure', WARMUP, DURATION),
  },
  // Los umbrales cumplen DOS funciones: marcan si la prueba "pasó" y hacen que k6 exporte las métricas por
  // endpoint (sin ellos el resumen solo trae el promedio de todo junto). compare.mjs lee estos nombres.
  thresholds: {
    'http_req_failed{phase:measure}': ['rate<0.01'],
    'http_reqs{phase:measure}': ['count>0'],
    'http_req_duration{phase:measure}': ['p(95)<2000'],
    'http_req_duration{phase:measure,endpoint:list}': ['p(95)<2000'],
    'http_req_duration{phase:measure,endpoint:overview}': ['p(95)<2000'],
    'http_req_duration{phase:measure,endpoint:search}': ['p(95)<2000'],
  },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Toma ids de restaurantes reales para pedir su pantalla. Si no hay, falta correr el seed. */
export function setup() {
  const ids = [];
  for (const page of [1, 2, 3]) {
    const res = http.get(`${BASE}/restaurants?limit=50&page=${page}`);
    if (res.status !== 200) throw new Error(`GET /restaurants respondió ${res.status}: ¿está arriba el BFF en ${BASE}?`);
    for (const r of res.json('data')) ids.push(r.id);
  }
  if (ids.length < 10) {
    throw new Error(`Hay solo ${ids.length} restaurantes. Corré antes el seed:  node perf/seed.mjs`);
  }
  console.log(`Usando ${ids.length} restaurantes. Carga: ${RATE} pedidos/s, ${WARMUP} de calentamiento + ${DURATION} medidos.`);
  return { ids };
}

export function browse(data) {
  const roll = Math.random();
  let url;
  let endpoint;

  if (roll < 0.45) {
    endpoint = 'list';
    const cuisine = pick(CUISINES);
    url = `${BASE}/restaurants?page=${1 + Math.floor(Math.random() * 5)}&limit=10${cuisine ? `&cuisine=${cuisine}` : ''}`;
  } else if (roll < 0.9) {
    endpoint = 'overview';
    url = `${BASE}/restaurants/${pick(data.ids)}/overview`;
  } else {
    endpoint = 'search';
    url = `${BASE}/restaurants?search=${pick(SEARCH_TERMS)}&limit=10`;
  }

  const res = http.get(url, { tags: { endpoint } });
  check(res, { 'responde 200': (r) => r.status === 200 });
}
