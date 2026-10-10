# Reservas Platform

Plataforma de **reservas de restaurantes** (con seña, carta y cobro) construida como **arquitectura de microservicios**. Es un proyecto de práctica pensado para demostrar patrones reales: BFF, comunicación asíncrona con eventos, trazabilidad de logs, tests, Docker y CI/CD.

> Estado: **Fase 2 completa** (`auth-service` + `restaurants-service`). Las demás fases están en la hoja de ruta.

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

| Servicio | Responsabilidad | Base de datos | Puerto | Estado |
|---|---|---|---|---|
| `auth-service` | Registro, login, JWT, roles | PostgreSQL | 3001 | ✅ Fase 1 |
| `restaurants-service` | Restaurantes, mesas, horarios y carta | MongoDB | 3002 | ✅ Fase 2 |
| `reservations-service` | Reservas, disponibilidad, estados, seña | PostgreSQL | — | Pendiente |
| `payments-service` | Seña y cobro, idempotencia, webhooks | PostgreSQL | — | Pendiente |
| `notifications-service` | Consume eventos y notifica | MongoDB | — | Pendiente |
| `web-bff` | Entrada única del frontend, agrega datos | — | — | Pendiente |

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

# 3b. ...o solo las bases en Docker y los servicios en modo desarrollo
npm run infra:up            # PostgreSQL + MongoDB
npm run dev:auth            # en una terminal
npm run dev:restaurants     # en otra terminal
```

| Servicio | API | Swagger | Health |
|---|---|---|---|
| auth | http://localhost:3001 | http://localhost:3001/docs | http://localhost:3001/health |
| restaurants | http://localhost:3002 | http://localhost:3002/docs | http://localhost:3002/health |

### Probar el flujo completo

1. En el Swagger de **auth**, registrá un usuario con `"role": "RESTAURANT_OWNER"` y copiá el `accessToken`.
2. En el Swagger de **restaurants**, tocá **Authorize** y pegá ese token (el mismo token sirve en los dos servicios).
3. Creá un restaurante (`POST /restaurants`), agregale platos (`POST /restaurants/{id}/menu-items`) y mirá la carta pública (`GET /restaurants/{id}/menu`).

### Tests

```bash
npm test                    # todos los servicios
npm run test:cov
```

Los tests no necesitan ninguna base de datos levantada.

## Decisiones de diseño (todos los servicios)

- **Una base de datos por servicio**: ningún servicio lee la base de otro.
- **Autenticación distribuida**: `auth-service` firma el JWT y el resto lo valida localmente con el mismo secreto (sin llamar a auth en cada request). El JWT contiene `sub` (id), `email` y `role`.
- **Un solo formato de error** en todos los servicios, así el BFF y el frontend los manejan igual:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["email must be an email"],
  "path": "/auth/register",
  "timestamp": "2026-10-10T00:12:05.579Z"
}
```

- **Validación estricta de entrada**: se rechazan propiedades que no están en el DTO (evita *mass assignment*; por ejemplo, el cliente no puede elegir el `ownerId`).
- **Los servicios no arrancan sin `JWT_SECRET`** (falla rápido en vez de correr inseguro).
- **Código de seguridad duplicado entre servicios** (guards, roles, filtro de errores): es el costo de la independencia. Cuando haya más servicios conviene moverlo a un paquete compartido del monorepo.

## auth-service

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/register` | Registra un usuario (`CUSTOMER` o `RESTAURANT_OWNER`) y devuelve un JWT |
| POST | `/auth/login` | Valida credenciales y devuelve un JWT |
| GET | `/auth/me` | Datos del usuario autenticado (`Authorization: Bearer <token>`) |
| GET | `/health` | Estado del servicio y de su base de datos |

- Contraseñas con bcrypt; el hash nunca sale en la API (`select: false` en la entidad).
- Mismo error para email inexistente y contraseña incorrecta, para no revelar qué emails están registrados.
- `synchronize` de TypeORM solo fuera de producción; en producción corresponde usar migraciones (pendiente).

## restaurants-service

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| GET | `/restaurants` | público | Lista paginada. Filtros: `page`, `limit` (máx. 50), `search`, `cuisine` |
| GET | `/restaurants/:id` | público | Detalle con mesas y horarios |
| POST | `/restaurants` | `RESTAURANT_OWNER` | Crea un restaurante; el dueño es el usuario del token |
| PATCH | `/restaurants/:id` | su dueño | Modifica campos sueltos |
| DELETE | `/restaurants/:id` | su dueño | Elimina el restaurante y su carta |
| GET | `/restaurants/:id/menu` | público | Carta agrupada por categoría (`?includeUnavailable=true` incluye los no disponibles) |
| POST | `/restaurants/:id/menu-items` | su dueño | Agrega un plato |
| PATCH | `/restaurants/:id/menu-items/:itemId` | su dueño | Modifica un plato (ej: marcarlo como no disponible) |
| DELETE | `/restaurants/:id/menu-items/:itemId` | su dueño | Quita un plato |
| GET | `/health` | público | Estado del servicio y de MongoDB |

### Decisiones de diseño

- **MongoDB para la carta**: cada plato tiene alérgenos y variantes de estructura variable, algo natural en documentos. Restaurante y carta están en **colecciones separadas**: la carta crece y cambia seguido, y así se modifica un plato sin reescribir todo el restaurante.
- **Mesas y horarios embebidos** en el restaurante: siempre se leen junto con él y no tienen vida propia.
- **Dos niveles de permiso**: el rol (`RESTAURANT_OWNER`) se valida en el guard, y que sea el dueño *de ese restaurante* se valida en el servicio (si no, cualquier dueño podría tocar restaurantes ajenos). Los platos se buscan siempre dentro del restaurante indicado.
- **Precios en centavos (enteros)**: el dinero nunca se guarda como decimal flotante (`0.1 + 0.2 !== 0.3`).
- **Alérgenos** según los 14 de declaración obligatoria de la UE.
- **Horarios que cruzan la medianoche**: si `closes` es menor que `opens`, el turno termina al día siguiente (típico de la cena). Un día puede tener varios turnos.
- **Búsqueda segura**: el texto del usuario se escapa antes de usarlo como expresión regular; los ids de ruta se validan como ObjectId (evita inyección NoSQL).
- **Referencia lógica, no clave foránea**: `ownerId` guarda el id del usuario de `auth-service`, pero no hay forma de verificar que exista desde acá. Es el costo de tener una base por servicio.
- Al borrar un restaurante se borra su carta en dos pasos, **sin transacción** (Mongo la exige en réplica). Un fallo a mitad de camino puede dejar platos huérfanos.

## Hoja de ruta

- [x] **Fase 1**: monorepo, `docker-compose`, `auth-service` con Swagger y tests
- [x] **Fase 2**: `restaurants-service` (MongoDB, carta)
- [ ] **Fase 3**: `reservations-service` (disponibilidad, estados, concurrencia)
- [ ] **Fase 4**: `web-bff` con validación de JWT y agregación de datos
- [ ] **Fase 5**: trazabilidad (`x-correlation-id`, logs JSON, Loki + Grafana)
- [ ] **Fase 6**: RabbitMQ, `payments-service` y saga de seña (idempotencia, compensaciones, DLQ)
- [ ] **Fase 7**: frontend React (React Query, Context, Redux) con tests
- [ ] **Fase 8**: performance (Redis, k6, Lighthouse) con mediciones antes/después
- [ ] **Fase 9**: CI/CD con GitHub Actions y publicación de imágenes

## Estructura

```
reservas-platform/
├── package.json            # npm workspaces
├── docker-compose.yml
├── .env.example
└── services/
    ├── auth-service/
    └── restaurants-service/
```
