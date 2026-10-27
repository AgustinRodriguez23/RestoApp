/**
 * Compara dos resultados de k6 (--summary-export) y arma una tabla en Markdown lista para pegar en el README.
 *
 * Uso:  node perf/compare.mjs perf/results/before.json perf/results/after.json
 */
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('Uso: node perf/compare.mjs perf/results/before.json perf/results/after.json');
  process.exit(1);
}

const load = (path) => JSON.parse(readFileSync(path, 'utf8')).metrics;
const before = load(beforePath);
const after = load(afterPath);

// Nombre legible de los endpoints conocidos; uno nuevo sale con su etiqueta tal cual
const LABELS = {
  list: 'Listado (cacheado)',
  overview: 'Pantalla de restaurante (cacheado)',
  search: 'Búsqueda por texto (NO cacheado, control)',
  mine: 'Mis reservas (limit=50)',
  'me-overview': 'Inicio del usuario (/me/overview)',
};
const durationKey = (endpoint) =>
  endpoint ? `http_req_duration{phase:measure,endpoint:${endpoint}}` : 'http_req_duration{phase:measure}';

// Los endpoints salen de los umbrales del script (cada uno exporta su métrica), en el orden en que aparecen
const endpointsIn = (metrics) =>
  Object.keys(metrics)
    .map((key) => /^http_req_duration\{phase:measure,endpoint:([^}]+)\}$/.exec(key)?.[1])
    .filter(Boolean);
const ENDPOINTS = [
  ...[...new Set([...endpointsIn(before), ...endpointsIn(after)])].map((e) => [e, LABELS[e] ?? e]),
  [null, 'Todos juntos'],
];

const ms = (value) => (value === undefined ? '—' : `${value.toFixed(1)} ms`);
const change = (b, a) => {
  if (b === undefined || a === undefined || b === 0) return '—';
  const pct = ((a - b) / b) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)} %`;
};

const lines = [
  '| Pedido | p50 antes | p50 después | p95 antes | p95 después | Cambio p95 |',
  '|---|---:|---:|---:|---:|---:|',
];
for (const [endpoint, label] of ENDPOINTS) {
  const b = before[durationKey(endpoint)];
  const a = after[durationKey(endpoint)];
  if (!b || !a) {
    lines.push(`| ${label} | sin datos | sin datos | sin datos | sin datos | — |`);
    continue;
  }
  lines.push(`| ${label} | ${ms(b.med)} | ${ms(a.med)} | ${ms(b['p(95)'])} | ${ms(a['p(95)'])} | ${change(b['p(95)'], a['p(95)'])} |`);
}

const count = (m) => m['http_reqs{phase:measure}']?.count;
const failed = (m) => m['http_req_failed{phase:measure}']?.value ?? m['http_req_failed{phase:measure}']?.rate;
const dropped = (m) => m.dropped_iterations?.count ?? 0;
const fmt = (n, digits = 1) => (n === undefined ? '—' : n.toFixed(digits));

console.log(lines.join('\n'));
console.log('');
console.log(`Pedidos medidos (RATE × DURATION si el sistema aguantó): ${count(before) ?? '—'} → ${count(after) ?? '—'}`);
console.log(`Pedidos fallidos: ${fmt((failed(before) ?? 0) * 100, 2)} % → ${fmt((failed(after) ?? 0) * 100, 2)} %`);
console.log(`Pedidos que el sistema no llegó a atender (descartados por k6): ${dropped(before)} → ${dropped(after)}`);
if (dropped(before) > 0 || dropped(after) > 0) {
  console.log('⚠ Hubo pedidos descartados: la carga superó lo que el sistema aguanta. Bajá RATE para comparar en igualdad de condiciones.');
}
