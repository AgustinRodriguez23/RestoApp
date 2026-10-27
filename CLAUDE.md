# Reservas Platform

Reservas de restaurantes con seña. Monorepo de npm workspaces (`services/*`, `apps/*`).
El `README.md` tiene la arquitectura y las decisiones de diseño de cada fase: leelo antes de tocar algo grande.

## Forma de trabajo

- Respondé en **español rioplatense**.
- **Explicá las decisiones** (el porqué, no solo el qué). Sin extras que no se pidieron.
- Si hay una duda de alcance que cambia mucho el trabajo, preguntá antes de construir.
- Antes de dar algo por hecho: corré los tests y el lint. Si algo no se pudo verificar, decilo.

## Arquitectura

| Paquete | Qué hace | Base | Puerto |
|---|---|---|---|
| `services/auth-service` | registro, login, JWT, roles | PostgreSQL | 3001 |
| `services/restaurants-service` | restaurantes, mesas, horarios, carta (caché en Redis) | MongoDB | 3002 |
| `services/reservations-service` | reservas, disponibilidad, seña, vencimiento | PostgreSQL | 3003 |
| `services/payments-service` | cobro de la seña, idempotencia, webhooks, reembolsos | PostgreSQL | 3004 |
| `services/notifications-service` | bandeja de avisos del cliente (consume eventos) | MongoDB | 3005 |
| `services/web-bff` | única puerta del frontend; valida JWT y reenvía | — | 3000 |
| `apps/web` | React + Vite + TypeScript + Tailwind, React Query | — | 5173 |

NestJS 11 (Express 5, Node 20+). Infra: RabbitMQ, Redis, Loki + Grafana.

## Comandos

```bash
npm install
cp .env.example .env              # definir JWT_SECRET y GATEWAY_WEBHOOK_SECRET
npm run infra:up                  # bases y RabbitMQ en Docker
npm run dev:auth | dev:restaurants | dev:reservations | dev:payments | dev:notifications | dev:bff | dev:web
npm run up                        # todo en contenedores (docker compose up --build)

npm test                          # unitarios de todos los workspaces
npm run test:integration          # contra Postgres y RabbitMQ reales (necesita infra:up)
npm run lint                      # ESLint, cero avisos permitidos
npm run build
npm run test:e2e                  # saga completa contra el sistema levantado con `npm run up`
```

Un workspace solo: `npm test -w reservations-service`.
Integración con otro Postgres: variables `TEST_DB_HOST/PORT/USER/PASSWORD/NAME` y `RABBITMQ_TEST_URL`.

## Reglas del proyecto (respetarlas)

- **Mensajería**: exchange `reservas.events` (topic). Sobre `{id, type, occurredAt, correlationId, data}`. Entrega **al menos una vez**: todo consumidor debe ser **idempotente** (tabla `processed_messages` en SQL; índice único de `eventId` en notifications). Manual ack, cola de reintentos con TTL y DLQ.
- **Cambios de eventos siempre aditivos**: agregar campos, nunca quitar ni renombrar (otros servicios los consumen).
- **Outbox**: reservations y payments publican por outbox transaccional, no directo.
- **Seguridad**: los servicios validan el JWT localmente (secreto compartido). Todo se filtra por el `sub` del token; el recurso de otro usuario responde **404**, no 403.
- **Dinero** en centavos (enteros). Fechas en UTC; los horarios de restaurante se interpretan en su zona (`America/Argentina/Buenos_Aires`).
- **Lint**: `eslint.config.mjs` usa `fileURLToPath` en vez de `import.meta.dirname` (decisión del autor; no revertir).
- **TypeORM**: en `UpdateQueryBuilder`, usar `.returning('*')`; con una lista de columnas devolvía solo `id` en Postgres.
- El código de mensajería (`src/messaging`) está **duplicado** en cada servicio a propósito por ahora (ver pendientes).
- Frontend: mobile-first. Probar a 320, 390 y 1280 px. En iOS Safari los inputs de fecha/hora necesitan las reglas de `index.css`.

## Tests

- Cada servicio tiene unitarios (Jest) e integración (`*.int-spec.ts`). `apps/web` usa Vitest + Testing Library con un servidor falso (`src/test/harness.tsx`).
- La integración de notifications usa RabbitMQ real pero **no MongoDB** (bandeja simulada en memoria). Mongo real se prueba solo en el e2e (sección 12).
- Si algo cambia en un evento o en una ruta del BFF, actualizar también `services/web-bff/src/http.spec.ts` y el e2e.

## CI/CD

`.github/workflows/ci.yml` (lint, unitarios ×7, integración, imágenes, e2e con docker compose, auditoría) y `release.yml` (publica imágenes). Dependabot activo. Al sumar un servicio hay que agregarlo a las matrices de ambos workflows.

## Pendientes conocidos

- Paquete compartido para el código duplicado (JWT, DTOs, enums, mensajería).
- NestJS 12 (requiere Node 24 y ESM) y avisos de audit en dev tools (vitest 3→5, jest 29→30).
- Notificaciones por `payment.refunded` y para el dueño del local; email o push.
