# Reservas Platform

Plataforma de **reservas de restaurantes** (con seña, carta y cobro) construida como **arquitectura de microservicios**. Es un proyecto de práctica pensado para demostrar patrones reales: BFF, comunicación asíncrona con eventos, trazabilidad de logs, tests, Docker y CI/CD.

> Estado: **Fase 4 completa** (`auth-service`, `restaurants-service`, `reservations-service` y `web-bff`). Las demás fases están en la hoja de ruta.

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
| `reservations-service` | Reservas, disponibilidad, estados (la seña llega en la Fase 6) | PostgreSQL | 3003 | ✅ Fase 3 |
| `payments-service` | Seña y cobro, idempotencia, webhooks | PostgreSQL | — | Pendiente |
| `notifications-service` | Consume eventos y notifica | MongoDB | — | Pendiente |
| `web-bff` | Entrada única del frontend, agrega datos | — | 3000 | ✅ Fase 4 |

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
npm run infra:up            # 2 PostgreSQL + MongoDB
npm run dev:auth            # en una terminal
npm run dev:restaurants     # en otra terminal
npm run dev:reservations    # en otra terminal
npm run dev:bff             # en otra terminal (el frontend solo habla con este)
```

| Servicio | API | Swagger | Health |
|---|---|---|---|
| auth | http://localhost:3001 | http://localhost:3001/docs | http://localhost:3001/health |
| restaurants | http://localhost:3002 | http://localhost:3002/docs | http://localhost:3002/health |
| reservations | http://localhost:3003 | http://localhost:3003/docs | http://localhost:3003/health |
| **web-bff** | http://localhost:3000 | http://localhost:3000/docs | http://localhost:3000/health |

### Probar el flujo completo

1. En el Swagger de **auth**, registrá un usuario con `"role": "RESTAURANT_OWNER"` y copiá el `accessToken`.
2. En el Swagger de **restaurants**, tocá **Authorize** y pegá ese token (el mismo token sirve en los dos servicios).
3. Creá un restaurante (`POST /restaurants`) con mesas y horarios, agregale platos (`POST /restaurants/{id}/menu-items`) y mirá la carta pública (`GET /restaurants/{id}/menu`).
4. En el Swagger de **reservations** consultá `GET /availability` (público) con el id del restaurante, un día y la cantidad de personas.
5. Registrá un usuario `CUSTOMER`, autorizá con su token y reservá con `POST /reservations` usando uno de los horarios devueltos. Probá pedir el mismo horario dos veces: la segunda da 409.

### Tests

```bash
npm test                    # todos los servicios
npm run test:cov
```

Los tests unitarios no necesitan ninguna base de datos levantada.

`reservations-service` además tiene **tests de integración contra un PostgreSQL real**, que son los que prueban que no se pueden hacer reservas dobles bajo concurrencia:

```bash
npm run infra:up                 # necesita postgres-reservations en el puerto 5434
npm run test:integration -w reservations-service
```

Usan un schema temporal que borran al terminar (no tocan tus datos). Si tu Postgres está en otro lado, definí `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD` y `TEST_DB_NAME`.

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

## reservations-service

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| GET | `/availability` | público | Horarios libres de un restaurante un día, para N personas (`restaurantId`, `date`, `partySize`) |
| POST | `/reservations` | usuario autenticado | Crea una reserva; la mesa se asigna sola |
| GET | `/reservations/mine` | usuario autenticado | Mis reservas, paginadas (`page`, `limit`, `status`) |
| GET | `/reservations/restaurant/:restaurantId` | dueño del restaurante | Reservas del restaurante (`date`, `status`, paginado) |
| GET | `/reservations/:id` | quien reservó o el dueño | Detalle |
| POST | `/reservations/:id/cancel` | quien reservó o el dueño | Cancela, solo antes de que empiece |
| PATCH | `/reservations/:id/status` | dueño del restaurante | `COMPLETED` o `NO_SHOW`, una vez que la reserva empezó |
| GET | `/health` | público | Estado del servicio y de PostgreSQL |

### Decisiones de diseño

- **Evitar la reserva doble lo decide la base, no el código.** Chequear "¿está libre?" y después insertar no es seguro si dos requests llegan a la vez: las dos ven la mesa libre. Por eso la tabla tiene una restricción `EXCLUDE USING gist` (con `btree_gist`) sobre `(restaurante, mesa, rango de tiempo)` para las reservas `CONFIRMED`. El servicio simplemente intenta insertar; si PostgreSQL responde `23P01` (solapamiento), prueba con la siguiente mesa apta y, si no queda ninguna, responde **409**. Se probó con 20 pedidos simultáneos sobre una sola mesa: exactamente uno gana.
- **Rangos `[inicio, fin)`**: una reserva que termina a las 21:30 y otra que empieza a las 21:30 en la misma mesa no se pisan.
- **Solo las `CONFIRMED` bloquean la mesa**: cancelar la libera.
- **Asignación automática de mesa**: la más chica en la que entra el grupo, así las mesas grandes quedan para grupos grandes.
- **Duración fija (90 min) y grilla de 30 min**: simplifica la disponibilidad. Se cambia con `RESERVATION_DURATION_MINUTES` y `RESERVATION_SLOT_STEP_MINUTES`. También `RESERVATION_MAX_ADVANCE_DAYS` (90 por defecto).
- **Zona horaria**: los horarios del restaurante son hora local (`RESTAURANT_TIME_ZONE`, por defecto Buenos Aires) y las reservas se guardan como instantes UTC (`timestamptz`). Se maneja con `Intl`, sin librerías, incluyendo los turnos que cruzan la medianoche y los cambios de horario de verano. Por ahora es **una sola zona para toda la plataforma**.
- **Máquina de estados**: `CONFIRMED → CANCELLED | COMPLETED | NO_SHOW`; los otros tres son finales. Cada transición es un `UPDATE ... WHERE id = ? AND status = <el que leí>`: si dos requests compiten (por ejemplo, dos cancelaciones), solo una gana y la otra recibe 409.
- **Comunicación síncrona con restaurants-service** (HTTP con timeout de 3 s y un reintento) para conocer mesas y horarios. Si no responde, 503; si responde algo inesperado, 502. Sin caché por ahora.
- **Recursos ajenos devuelven 404, no 403**: no se revela que una reserva de otra persona existe.
- **El cliente de una reserva siempre es el usuario del token**; el DTO rechaza `customerId`, `status` o `tableNumber` (*mass assignment*).

### Limitaciones conocidas

- `/availability` es una **foto del momento**: entre que se consulta y se reserva, otra persona puede tomar la mesa, así que reservar puede dar 409 aunque figurara libre. Es lo esperable, y la base lo garantiza.
- Si el dueño modifica las mesas o los horarios en restaurants-service, las reservas ya hechas **no se revalidan**. Y si una mesa desaparece, sus reservas quedan apuntando a un número que ya no existe.
- La restricción se crea al arrancar (`reservations-schema.bootstrap.ts`) y `synchronize` crea las tablas: para producción corresponde usar migraciones.
- El usuario de la base necesita permiso para `CREATE EXTENSION btree_gist` (en el contenedor ya lo tiene).
- No hay seña ni pago todavía: llegan en la Fase 6 con RabbitMQ.

## web-bff

Es la única puerta que usará el frontend. Valida el JWT, reenvía a los servicios y **agrega** datos de varios en una sola respuesta.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | Reenvían a auth-service |
| GET | `/auth/me` | Perfil del usuario |
| GET | `/restaurants` | Listado con búsqueda y filtros |
| GET | `/restaurants/:id/overview` | **Agregada**: restaurante + carta + (con `?date=&partySize=`) horarios libres |
| POST | `/reservations` | Crea la reserva; la respuesta incluye el nombre del restaurante |
| GET | `/reservations/mine` | Mis reservas, **cada una con el nombre de su restaurante** |
| GET | `/reservations/:id`, POST `/reservations/:id/cancel` | Ver y cancelar |
| GET | `/me/overview` | **Agregada**: mi perfil + mis próximas 5 reservas |
| GET | `/health` | Estado del BFF y de cada servicio (`ok` / `degraded`) |

### Decisiones de diseño

- **Agregación en paralelo con degradación parcial.** `overview` pide restaurante, carta y disponibilidad a la vez (`Promise.all`). Lo imprescindible (el restaurante, el perfil) propaga el error si falla; lo complementario (carta, disponibilidad, reservas) se devuelve en `null` con un aviso en `warnings`, así la pantalla se muestra igual.
- **Un solo cliente HTTP (`UpstreamClient`)** con timeout en toda llamada, reenvío del token y del `x-correlation-id`, y reintento **solo de GET** (repetir un POST podría duplicar una reserva).
- **Traducción de errores**: un 4xx del servicio (409 sin mesas, 404, 400...) llega igual al usuario; un 5xx es **502**, un timeout **504** y un servicio inaccesible **503**. Los mensajes no revelan direcciones internas.
- **Validación en dos capas**: el BFF valida el formato y el token primero (si algo es inválido ni siquiera molesta a los servicios); los permisos por rol y por recurso los sigue decidiendo cada servicio.
- **Enriquecimiento sin repetir llamadas**: para poner el nombre del restaurante en cada reserva se consulta una vez por restaurante distinto, máximo 10 en simultáneo.
- **`x-correlation-id`**: se genera (o se respeta el del cliente si es válido), se devuelve en la respuesta y se reenvía a los servicios. La Fase 5 lo usa para los logs.
- **CORS solo en el BFF**: es el único servicio que llama el navegador (`CORS_ORIGIN`).

### Limitaciones conocidas

- Sin caché: `/reservations/mine` consulta restaurants-service en cada llamada (Redis llega en la Fase 8).
- No hay endpoints para el dueño del restaurante (crear restaurantes, carta, ver reservas del local): se agregan cuando el frontend los necesite.
- Los DTOs de entrada están duplicados respecto de cada servicio; si cambian allá hay que actualizarlos acá.

## Hoja de ruta

- [x] **Fase 1**: monorepo, `docker-compose`, `auth-service` con Swagger y tests
- [x] **Fase 2**: `restaurants-service` (MongoDB, carta)
- [x] **Fase 3**: `reservations-service` (disponibilidad, estados, concurrencia)
- [x] **Fase 4**: `web-bff` con validación de JWT y agregación de datos
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
