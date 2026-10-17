# Mediciones de rendimiento (Fase 8)

Acá está todo lo necesario para medir **antes y después** del caché de Redis, con tus propios números.

> **Por qué hay que medir en tu máquina:** yo no tengo MongoDB en mi entorno, así que no puedo darte los tiempos del backend.
> Lo que sí hice fue probar que los scripts corren, que el caché devuelve datos correctos y que se invalida bien.
> Los números del front (Lighthouse) sí los medí; están en el README principal.

## Qué se mide

`read-heavy.k6.js` simula gente que **navega** (solo lecturas) a través del BFF:

| Parte del tráfico | Pedido | ¿Cacheado? |
|---|---|---|
| 45 % | Listado de restaurantes (páginas 1-5, a veces por cocina) | Sí |
| 45 % | Pantalla de un restaurante (`/restaurants/:id/overview`: detalle + carta) | Sí |
| 10 % | Búsqueda por texto | **No** (es el grupo de control: no tendría que cambiar) |

La carga es de **llegadas constantes** (por defecto 100 pedidos por segundo, 10 s de calentamiento que no se mide + 30 s medidos).
Se eligió así porque, a diferencia de "N usuarios en paralelo", no se frena sola si el sistema se atrasa: el atraso aparece en la latencia.

## Paso a paso

Todos los comandos se corren en la raíz del repo, con el sistema levantado (`npm run up`, o `docker compose up -d --build`).
k6 corre **dentro de Docker** (no hay que instalar nada) y por fuera del arranque normal: solo se levanta si lo pedís con `--profile perf`.

### 0. Cargar datos de prueba

```bash
node perf/seed.mjs
```

Crea 150 restaurantes con 30 platos cada uno (se puede repetir: solo crea los que faltan). Sin datos, MongoDB responde tan rápido
que no hay nada que acelerar. Si querés más volumen: `COUNT=500 ITEMS=60 node perf/seed.mjs`.

### 1. Medir SIN caché

En el archivo `.env` de la raíz agregá esta línea (vacía a propósito) y recreá el servicio:

```
RESTAURANTS_REDIS_URL=
```

```bash
docker compose up -d restaurants-service
docker compose logs restaurants-service | grep -i "caché"     # tiene que decir: Caché DESACTIVADO
```

```bash
docker compose --profile perf run --rm k6 run /perf/read-heavy.k6.js --summary-export=/perf/results/before.json
```

### 2. Medir CON caché

Sacá (o comentá) la línea `RESTAURANTS_REDIS_URL=` del `.env` y recreá el servicio:

```bash
docker compose up -d restaurants-service
docker compose logs restaurants-service | grep -i "caché"     # tiene que decir: Caché ACTIVADO
```

```bash
docker compose --profile perf run --rm k6 run /perf/read-heavy.k6.js --summary-export=/perf/results/after.json
```

### 3. Comparar

```bash
node perf/compare.mjs perf/results/before.json perf/results/after.json
```

Imprime una tabla en Markdown lista para pegar en el README principal.

### 4. Comprobar que el caché de verdad trabajó

```bash
docker compose exec redis redis-cli info stats | grep -E "keyspace_(hits|misses)"
docker compose exec redis redis-cli dbsize
```

Con la prueba "con caché" tienen que aparecer muchos más `hits` que `misses` y unas decenas de claves.
Con "sin caché" no tiene que haber ninguna.

## Cómo leer los resultados (para no engañarse)

- **Corré dos veces lo mismo** antes de comparar (por ejemplo, dos corridas "sin caché") y mirá cuánto cambian entre sí.
  Esa diferencia es el **ruido** de tu máquina. En mi prueba de ensayo, dos corridas idénticas dieron diferencias de entre -21 % y +12 %
  en el p95: una mejora menor a eso no se puede distinguir de la suerte.
- **p50 y p95**: el p50 es lo que vive un usuario típico; el p95, lo que vive 1 de cada 20 en su peor momento. Mirá los dos.
- **Pedidos descartados** (`dropped_iterations`): si aparecen, la carga superó lo que el sistema aguanta y las latencias dejan de ser comparables.
  Bajá la carga: `RATE=50 docker compose --profile perf run --rm k6 run ...`.
- **Qué esperar**: con pocos datos y todo en la misma máquina, la mejora puede ser modesta (milisegundos). El caché luce más cuando
  la base está lejos o ocupada, o cuando hay mucha concurrencia. Si no ves diferencia, aumentá los datos (`COUNT`, `ITEMS`) o la carga (`RATE`):
  es un resultado válido y vale la pena anotarlo tal cual.
- **Mejor caso**: esta prueba repite pocas páginas y pocos restaurantes, así que casi todo es *hit*. Con tráfico real, repartido en cientos
  de restaurantes, la tasa de aciertos sería menor.

## Lighthouse (el front)

Con el front levantado (`http://localhost:5173`) y Chrome instalado:

```bash
npx lighthouse http://localhost:5173/ --only-categories=performance,accessibility,best-practices,seo --view
```

Una sola corrida varía mucho (en mis pruebas, de 85 a 91 puntos con la misma página): repetí 5 veces y tomá la mediana.
Para volver a ver el "antes", comentá las líneas `gzip…` de `apps/web/nginx.conf`, reconstruí con `docker compose up -d --build web` y medí.
