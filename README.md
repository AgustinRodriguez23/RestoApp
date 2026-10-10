# Reservas Platform

Plataforma de **reservas de restaurantes** (con seña, carta y cobro) construida como **arquitectura de microservicios**. Es un proyecto de práctica pensado para demostrar patrones reales: BFF, comunicación asíncrona con eventos, trazabilidad de logs, tests, Docker y CI/CD.

> Estado: **Fase 1 completa** (monorepo + `auth-service`). Las demás fases están en la hoja de ruta.

## Arquitectura objetivo

```
  React (Vite + TS)
        │
        ▼
  ┌───────────┐        Redis (caché)
  │  web-bff  │ ◄────────────┐
  └─────┬─────┘              │
   ┌────┼────────────┬───────┴────────┐
   ▼    ▼            ▼                ▼
 auth  restaurants  reservations   payments
 (PG)  (MongoDB)    (PG)           (PG)
                       ▲  │            ▲
                       └──┴─ RabbitMQ ─┘  → notifications (MongoDB)

  Todos → logs JSON con correlationId → Loki → Grafana
```

| Servicio | Responsabilidad | Base de datos | Estado |
|---|---|---|---|
| `auth-service` | Registro, login, JWT, roles | PostgreSQL | ✅ Fase 1 |
| `restaurants-service` | Restaurantes, mesas, horarios y carta | MongoDB | Pendiente |
| `reservations-service` | Reservas, disponibilidad, estados, seña | PostgreSQL | Pendiente |
| `payments-service` | Seña y cobro, idempotencia, webhooks | PostgreSQL | Pendiente |
| `notifications-service` | Consume eventos y notifica | MongoDB | Pendiente |
| `web-bff` | Entrada única del frontend, agrega datos | — | Pendiente |

## Stack

NestJS · TypeScript · PostgreSQL · MongoDB · RabbitMQ · Redis · React · Docker · GitHub Actions · Jest

## Cómo levantarlo

Requisitos: Node 20+ y Docker.

```bash
# 1. Variables de entorno
cp .env.example .env        # y cambiá JWT_SECRET por un valor propio

# 2. Instalar dependencias de todos los servicios (npm workspaces)
npm install

# 3a. Todo en contenedores
npm run up

# 3b. ...o solo la base en Docker y el servicio en modo desarrollo
npm run infra:up
npm run dev:auth
```

- API: http://localhost:3001
- Swagger: http://localhost:3001/docs
- Health check: http://localhost:3001/health

### Tests

```bash
npm test                    # todos los servicios
npm run test:cov
```

## auth-service

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/register` | Registra un usuario (`CUSTOMER` o `RESTAURANT_OWNER`) y devuelve un JWT |
| POST | `/auth/login` | Valida credenciales y devuelve un JWT |
| GET | `/auth/me` | Datos del usuario autenticado (`Authorization: Bearer <token>`) |
| GET | `/health` | Estado del servicio y de su base de datos |

El JWT contiene `sub` (id), `email` y `role`. Los demás servicios y el BFF van a validar el token con el mismo secreto.

Todos los errores salen con el mismo formato (lo van a reutilizar los demás servicios):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["email must be an email"],
  "path": "/auth/register",
  "timestamp": "2026-10-10T00:12:05.579Z"
}
```

### Decisiones de diseño

- **Una base de datos por servicio**: ningún servicio lee la base de otro.
- **Contraseñas con bcrypt**; el hash nunca sale en la API (`select: false` en la entidad).
- **Mismo error para email inexistente y contraseña incorrecta**, para no revelar qué emails están registrados.
- **El servicio no arranca sin `JWT_SECRET`** (falla rápido en vez de correr inseguro).
- **Validación estricta de entrada**: se rechazan propiedades que no están en el DTO (evita *mass assignment*).
- **`synchronize` de TypeORM solo fuera de producción**; en producción corresponde usar migraciones (pendiente).

## Hoja de ruta

- [x] **Fase 1**: monorepo, `docker-compose`, `auth-service` con Swagger y tests
- [ ] **Fase 2**: `restaurants-service` (MongoDB, carta) y `reservations-service`
- [ ] **Fase 3**: `web-bff` con validación de JWT y agregación de datos
- [ ] **Fase 4**: trazabilidad (`x-correlation-id`, logs JSON, Loki + Grafana)
- [ ] **Fase 5**: RabbitMQ, `payments-service` y saga de seña (idempotencia, compensaciones, DLQ)
- [ ] **Fase 6**: frontend React (React Query, Context, Redux) con tests
- [ ] **Fase 7**: performance (Redis, k6, Lighthouse) con mediciones antes/después
- [ ] **Fase 8**: CI/CD con GitHub Actions y publicación de imágenes

## Estructura

```
reservas-platform/
├── package.json            # npm workspaces
├── docker-compose.yml
├── .env.example
└── services/
    └── auth-service/
```
