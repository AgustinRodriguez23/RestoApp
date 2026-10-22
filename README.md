# Reservas Platform

Plataforma de **reservas de restaurantes** (con seña, carta y cobro) construida como **arquitectura de microservicios**. Es un proyecto de práctica pensado para demostrar patrones reales: BFF, comunicación asíncrona con eventos, trazabilidad de logs, tests, Docker y CI/CD.

> Estado: **Fases 1 a 9 completas** (la 8, de performance, con mediciones del front y del backend) y el **panel del dueño** (reservas del local). Quedan los pendientes de la hoja de ruta.

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
                       └──┴─ RabbitMQ ─┘
                              │
                              └──▶ notifications (MongoDB) ◀── también lo consulta el BFF

  Todos → logs JSON con correlationId → Loki → Grafana
```

| Servicio | Responsabilidad | Base de datos | Puerto | Estado |
|---|---|---|---|---|
| `auth-service` | Registro, login, JWT, roles | PostgreSQL | 3001 | ✅ Fase 1 |
| `restaurants-service` | Restaurantes, mesas, horarios y carta | MongoDB | 3002 | ✅ Fase 2 |
| `reservations-service` | Reservas, disponibilidad, estados, seña y vencimiento | PostgreSQL | 3003 | ✅ Fase 3 y 6 |
| `payments-service` | Seña y cobro, idempotencia, webhooks, reembolsos | PostgreSQL | 3004 | ✅ Fase 6 |
| `notifications-service` | Consume eventos de reservas y arma la bandeja de avisos del cliente | MongoDB | 3005 | ✅ Notificaciones |
| `web-bff` | Entrada única del frontend, agrega datos | — | 3000 | ✅ Fase 4 |
| `web` (`apps/web`) | Frontend React: buscar, reservar, pagar la seña | — | 5173 | ✅ Fase 7 |
| `redis` | Caché de lecturas de `restaurants-service` | — | 6379 | ✅ Fase 8 |

## Stack

NestJS · TypeScript · PostgreSQL · MongoDB · RabbitMQ · Redis · React · Docker · GitHub Actions · Jest

## Cómo levantarlo

Requisitos: Node 20+ y Docker.

```bash
# 1. Variables de entorno
cp .env.example .env        # y cambiá JWT_SECRET y GATEWAY_WEBHOOK_SECRET por valores propios

# 2. Instalar dependencias de todos los servicios (npm workspaces)
npm install

# 3a. Todo en contenedores
npm run up

# 3b. ...o solo las bases en Docker y los servicios en modo desarrollo
npm run infra:up            # 3 PostgreSQL + MongoDB + RabbitMQ
npm run dev:auth            # en una terminal
npm run dev:restaurants     # en otra terminal
npm run dev:reservations    # en otra terminal
npm run dev:payments        # en otra terminal
npm run dev:notifications   # en otra terminal (la bandeja de avisos)
npm run dev:bff             # en otra terminal (el frontend solo habla con este)
npm run dev:web             # el frontend: http://localhost:5173
npm run obs:up              # Loki + Alloy + Grafana (ver «Trazabilidad de logs»)
```

| Servicio | API | Swagger | Health |
|---|---|---|---|
| auth | http://localhost:3001 | http://localhost:3001/docs | http://localhost:3001/health |
| restaurants | http://localhost:3002 | http://localhost:3002/docs | http://localhost:3002/health |
| reservations | http://localhost:3003 | http://localhost:3003/docs | http://localhost:3003/health |
| payments | http://localhost:3004 | http://localhost:3004/docs | http://localhost:3004/health |
| notifications | http://localhost:3005 | http://localhost:3005/docs | http://localhost:3005/health |
| RabbitMQ (panel) | http://localhost:15672 (usuario `reservas`, clave `reservas_password`) | — | — |
| **web-bff** | http://localhost:3000 | http://localhost:3000/docs | http://localhost:3000/health |
| **web (frontend)** | http://localhost:5173 | — | — |

### Probar el flujo completo

1. En el Swagger de **auth**, registrá un usuario con `"role": "RESTAURANT_OWNER"` y copiá el `accessToken` (hace falta `ALLOW_OWNER_SELF_REGISTER=true`, que ya viene en `.env.example`; sin esa variable el servicio responde 403).
2. En el Swagger de **restaurants**, tocá **Authorize** y pegá ese token (el mismo token sirve en los dos servicios).
3. Creá un restaurante (`POST /restaurants`) con mesas y horarios, agregale platos (`POST /restaurants/{id}/menu-items`) y mirá la carta pública (`GET /restaurants/{id}/menu`).
4. En el Swagger de **reservations** consultá `GET /availability` (público) con el id del restaurante, un día y la cantidad de personas.
5. Registrá un usuario `CUSTOMER`, autorizá con su token y reservá con `POST /reservations` usando uno de los horarios devueltos. Probá pedir el mismo horario dos veces: la segunda da 409.
6. Con la seña activada (`DEPOSIT_PER_PERSON_CENTS` > 0, por defecto sí) la reserva queda `PENDING_PAYMENT`. Pagala con `POST /reservations/{id}/pay` **del BFF** (header `Idempotency-Key` y `{"token": "tok_approved"}`) y mirá cómo pasa a `CONFIRMED`. Todo el recorrido está explicado en «Fase 6: mensajería y pagos».

### Tests

```bash
npm test                    # todos los servicios
npm run test:cov
```

Los tests unitarios no necesitan ninguna base de datos levantada.

### Lint (ESLint)

```bash
npm run lint        # toda la plataforma, ~20 s; falla con cualquier aviso
npm run lint:fix    # arregla solo lo que ESLint puede arreglar sin cambiar el sentido
```

Hay **una sola configuración en la raíz** (`eslint.config.mjs`, formato *flat* de ESLint 9) con secciones por carpeta: servicios NestJS (Node + Jest), frontend (navegador + reglas de hooks de React) y scripts `.mjs` (e2e, perf). ESLint no reemplaza al compilador: `tsc` valida tipos, ESLint busca errores que los tipos no ven.

Decisiones:

- **Nivel `recommended` de ESLint y typescript-eslint**, no el `strict`. Se midió antes de decidir: con ese nivel salían 3 avisos en 298 archivos, así que no hacía falta aflojar ni silenciar nada.
- **Tres reglas que usan información de tipos**: `no-floating-promises`, `no-misused-promises` y `await-thenable`. Atrapan una promesa que nadie espera, cuyo error se pierde sin ruido. Encontraron 13 casos: los 5 `bootstrap()` de los `main.ts` (si el arranque fallaba no había un manejo explícito; ahora se loguea y el proceso sale con código 1), las llamadas a `navigate()` del front y un servidor HTTP falso de tests que, si un handler explotaba, tiraba el proceso.
- **`react-hooks/exhaustive-deps`** viene activo (dependencias de `useEffect`/`useCallback`): salió limpio.
- **Los parámetros sin usar** se permiten con prefijo `_`; sin él son error.
- **Sin Prettier**: ESLint solo revisa errores, no el formato. Si se suma, que sea una herramienta aparte para no mezclar las dos cosas.
- El CI corre `npm run lint` como un job propio (en paralelo a los unitarios).

`reservations-service` además tiene **tests de integración contra un PostgreSQL real**, que son los que prueban que no se pueden hacer reservas dobles bajo concurrencia:

```bash
npm run infra:up                 # necesita postgres-reservations en el puerto 5434
npm run test:integration -w reservations-service
```

Usan un schema temporal que borran al terminar (no tocan tus datos). Si tu Postgres está en otro lado, definí `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD` y `TEST_DB_NAME`.

Desde la Fase 6 `reservations-service` y `payments-service` también prueban **contra RabbitMQ real** (reintentos, DLQ, duplicados, reconexión...); `npm run infra:up` levanta todo lo necesario (`RABBITMQ_TEST_URL` si tu broker está en otro lado; `TEST_DB_PORT=5435` para payments):

```bash
npm run test:integration           # todos los servicios con integración
```

Y hay una **prueba de punta a punta** que recorre la saga completa contra el sistema en marcha (BFF → reservas ⇄ RabbitMQ ⇄ pagos → pasarela simulada):

```bash
npm run up                         # o los servicios con dev:* + infra:up
npm run test:e2e                   # E2E_EXPIRY=1 agrega el vencimiento (tarda más)
```

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
| POST | `/auth/register` | Registra un usuario y devuelve un JWT. Es `CUSTOMER` salvo que se pida `RESTAURANT_OWNER` y esté activado `ALLOW_OWNER_SELF_REGISTER` (si no, 403: el registro es público y cualquiera se haría dueño) |
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
| GET | `/reservations/restaurant/:restaurantId/summary` | dueño del restaurante | **Resumen de un día** (`date` obligatoria): cuántas reservas hay por estado |
| GET | `/reservations/:id` | quien reservó o el dueño | Detalle |
| POST | `/reservations/:id/cancel` | quien reservó o el dueño | Cancela, solo antes de que empiece |
| PATCH | `/reservations/:id/status` | dueño del restaurante | `COMPLETED` o `NO_SHOW`, una vez que la reserva empezó |
| GET | `/health` | público | Estado del servicio, de PostgreSQL y de RabbitMQ |

### Decisiones de diseño

- **Evitar la reserva doble lo decide la base, no el código.** Chequear "¿está libre?" y después insertar no es seguro si dos requests llegan a la vez: las dos ven la mesa libre. Por eso la tabla tiene una restricción `EXCLUDE USING gist` (con `btree_gist`) sobre `(restaurante, mesa, rango de tiempo)` para las reservas `CONFIRMED`. El servicio simplemente intenta insertar; si PostgreSQL responde `23P01` (solapamiento), prueba con la siguiente mesa apta y, si no queda ninguna, responde **409**. Se probó con 20 pedidos simultáneos sobre una sola mesa: exactamente uno gana.
- **Rangos `[inicio, fin)`**: una reserva que termina a las 21:30 y otra que empieza a las 21:30 en la misma mesa no se pisan.
- **Bloquean la mesa las `CONFIRMED` y las `PENDING_PAYMENT`** (esperando la seña): cancelar, vencer o fallar el pago la libera. Al arrancar, si la base tiene la restricción vieja (solo `CONFIRMED`), se reemplaza sola en una transacción.
- **Asignación automática de mesa**: la más chica en la que entra el grupo, así las mesas grandes quedan para grupos grandes.
- **Duración fija (90 min) y grilla de 30 min**: simplifica la disponibilidad. Se cambia con `RESERVATION_DURATION_MINUTES` y `RESERVATION_SLOT_STEP_MINUTES`. También `RESERVATION_MAX_ADVANCE_DAYS` (90 por defecto).
- **Zona horaria**: los horarios del restaurante son hora local (`RESTAURANT_TIME_ZONE`, por defecto Buenos Aires) y las reservas se guardan como instantes UTC (`timestamptz`). Se maneja con `Intl`, sin librerías, incluyendo los turnos que cruzan la medianoche y los cambios de horario de verano. Por ahora es **una sola zona para toda la plataforma**.
- **Máquina de estados**: `PENDING_PAYMENT → CONFIRMED | CANCELLED | EXPIRED` y `CONFIRMED → CANCELLED | COMPLETED | NO_SHOW`; el resto son finales. Cada transición es un `UPDATE ... WHERE id = ? AND status = <el que leí>`: si dos requests compiten (por ejemplo, dos cancelaciones), solo una gana y la otra recibe 409.
- **Comunicación síncrona con restaurants-service** (HTTP con timeout de 3 s y un reintento) para conocer mesas y horarios. Si no responde, 503; si responde algo inesperado, 502. Sin caché por ahora.
- **Recursos ajenos devuelven 404, no 403**: no se revela que una reserva de otra persona existe.
- **El cliente de una reserva siempre es el usuario del token**; el DTO rechaza `customerId`, `status` o `tableNumber` (*mass assignment*).

### Limitaciones conocidas

- `/availability` es una **foto del momento**: entre que se consulta y se reserva, otra persona puede tomar la mesa, así que reservar puede dar 409 aunque figurara libre. Es lo esperable, y la base lo garantiza.
- Si el dueño modifica las mesas o los horarios en restaurants-service, las reservas ya hechas **no se revalidan**. Y si una mesa desaparece, sus reservas quedan apuntando a un número que ya no existe.
- La restricción se crea al arrancar (`reservations-schema.bootstrap.ts`) y `synchronize` crea las tablas: para producción corresponde usar migraciones.
- El usuario de la base necesita permiso para `CREATE EXTENSION btree_gist` (en el contenedor ya lo tiene).
- Con `DEPOSIT_PER_PERSON_CENTS=0` no hay seña y las reservas nacen `CONFIRMED`, como antes de la Fase 6.

## web-bff

Es la única puerta que usará el frontend. Valida el JWT, reenvía a los servicios y **agrega** datos de varios en una sola respuesta.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | Reenvían a auth-service |
| GET | `/auth/me` | Perfil del usuario |
| GET | `/restaurants` | Listado con búsqueda y filtros |
| GET | `/restaurants/:id/overview` | **Agregada**: restaurante + carta + (con `?date=&partySize=`) horarios libres |
| POST | `/reservations` | Crea la reserva; la respuesta incluye el nombre del restaurante |
| GET | `/reservations/mine` | Mis reservas, **cada una con el nombre de su restaurante y el estado de su pago** |
| GET | `/reservations/:id`, POST `/reservations/:id/cancel` | Ver y cancelar |
| POST | `/reservations/:id/pay` | **Paga la seña** (header `Idempotency-Key` obligatorio): busca el pago de la reserva y cobra |
| GET | `/reservations/:id/payment` | Estado del pago de la seña |
| GET | `/me/overview` | **Agregada**: mi perfil + mis próximas 5 reservas + las que esperan el pago |
| GET | `/owner/restaurants` | **Dueño**: mis restaurantes |
| GET | `/owner/restaurants/:id/summary` | **Dueño**: resumen de un día (`date`): conteo de reservas por estado |
| POST | `/owner/restaurants` | **Dueño**: crea un restaurante (el dueño es el del token, nunca el del cuerpo) |
| PATCH, DELETE | `/owner/restaurants/:id` | **Dueño**: edita datos, mesas y horarios / elimina el restaurante y su carta |
| GET | `/owner/restaurants/:id/menu` | **Dueño**: su carta completa, **incluyendo los platos pausados** |
| POST | `/owner/restaurants/:id/menu-items` | **Dueño**: agrega un plato |
| PATCH, DELETE | `/owner/restaurants/:id/menu-items/:itemId` | **Dueño**: edita, pausa (`available: false`) o quita un plato |
| GET | `/owner/restaurants/:id/reservations` | **Dueño**: reservas del local (`date`, `status`, `page`, `limit`) |
| PATCH | `/owner/reservations/:id/status` | **Dueño**: `COMPLETED` (asistió) o `NO_SHOW` (no vino). Para cancelar se usa `POST /reservations/:id/cancel`, que ya acepta al dueño |
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

- Sin caché propio: `/reservations/mine` consulta restaurants-service en cada llamada (desde la Fase 8 ese servicio responde desde Redis; ver «Fase 8»).
- Del dueño están las reservas del local, la gestión del restaurante (mesas y horarios) y su carta (ver «Panel del dueño»).
- Los DTOs de entrada están duplicados respecto de cada servicio; si cambian allá hay que actualizarlos acá.

## Fase 6: mensajería y pagos

Al reservar con seña, **reservas** y **pagos** se coordinan solo con eventos por RabbitMQ (coreografía, sin que ninguno llame al otro por HTTP):

```
 cliente ──POST /reservations──▶ reservations ──reservation.created──▶ payments
                                 (PENDING_PAYMENT,                      (crea el pago PENDING)
                                  mesa retenida 15 min)
 cliente ──POST /reservations/:id/pay (Idempotency-Key)──▶ BFF ──▶ payments ──▶ pasarela
                                                                       │
        ┌────────────────── payment.succeeded ◀────────────────────────┤  aprobado
        ▼                                                              │
 reservations: CONFIRMED                                               │  rechazado ──payment.failed──▶ reservations: CANCELLED (mesa libre)
                                                                       │
 plazo vencido ─ reservations: EXPIRED ──reservation.expired──▶ payments: pago EXPIRED
 cancelación ───reservation.cancelled {refundable}────────────▶ payments: anula, o DEVUELVE la seña si corresponde
 pago que llega tarde ──reservation.refund_requested──────────▶ payments: devuelve (compensación)
```

### Cómo probarlo a mano

Con `npm run up` (la seña por defecto es $2.000 por persona), en el Swagger del **BFF** (http://localhost:3000/docs):

1. `POST /reservations` → vuelve `PENDING_PAYMENT` con `depositCents` y `expiresAt` (la mesa queda retenida hasta ese momento).
2. `POST /reservations/{id}/pay` con un header `Idempotency-Key` (cualquier UUID) y uno de los **tokens de prueba** de la pasarela simulada:

| Token | Qué pasa |
|---|---|
| `tok_approved` | Aprobado al instante → la reserva pasa a `CONFIRMED` |
| `tok_declined` / `tok_insufficient_funds` | Rechazado → la reserva se cancela y la mesa se libera |
| `tok_error` | La pasarela "se cae": 502, no se cobró nada, se puede reintentar con la misma clave |
| `tok_slow` | Responde **202** (`PROCESSING`) y a los 3 s la pasarela avisa **por webhook firmado** → `CONFIRMED` |
| `tok_slow_declined` | Ídem, pero el webhook dice rechazado |
| `tok_slow_duplicate` | El webhook llega **dos veces**: se aplica una sola |

3. Repetí el mismo pedido con la misma `Idempotency-Key`: devuelve lo mismo (header `Idempotent-Replayed: true`) sin cobrar de nuevo. Con otra clave: 409 (ya está pagado).
4. Probá **no pagar**: pasados `PAYMENT_WINDOW_MINUTES` la reserva queda `EXPIRED` y el pago también.
5. Cancelá una reserva pagada: si faltan más de `REFUND_CUTOFF_HOURS` el pago pasa a `REFUNDED`; si no, la seña se pierde (si cancela el dueño del restaurante, siempre se devuelve).
6. Mirá los mensajes en el panel de RabbitMQ (http://localhost:15672) y el recorrido completo en Grafana buscando el `correlationId` de la reserva.

### Mensajería confiable (`src/messaging`, igual en reservations y payments)

| Problema | Solución |
|---|---|
| Guardar en la base y publicar en RabbitMQ no pueden ser una sola transacción: un corte entre los dos pierde el evento o avisa de algo que no pasó | **Transactional outbox**: el evento se guarda como una fila en la **misma transacción** que el cambio de negocio; un *relay* lo publica después y reintenta con espera creciente hasta que RabbitMQ **confirma** (publisher confirms) |
| Varias instancias del servicio publicarían lo mismo dos veces | El relay toma lotes con `FOR UPDATE SKIP LOCKED`: cada instancia agarra filas distintas y nunca espera a otra |
| La entrega es "al menos una vez": un mensaje puede llegar repetido | **Consumidor idempotente**: se inserta `(consumidor, id del mensaje)` en `processed_messages` en la **misma transacción** que el efecto; si ya estaba, es un duplicado y solo se confirma |
| El handler falla (error transitorio) | Va a `<cola>.retry`, que lo devuelve a la cola de trabajo pasado un tiempo (TTL + dead-letter). Hasta `maxAttempts` intentos |
| El mensaje es basura, o el error nunca se va a arreglar solo | Directo a `<cola>.dlq` con el motivo (`x-error`) y los intentos, para inspeccionarlo y reprocesarlo a mano |
| Se cae RabbitMQ | El servicio sigue andando y los eventos esperan en el outbox; la conexión se reintenta sola y los consumidores se vuelven a armar |
| Seguir una saga entre servicios | El `correlationId` viaja en el sobre del evento y en el header del mensaje; el consumidor lo restaura antes de correr el handler |

Sobre de todos los eventos: `{ id, type, occurredAt, correlationId, data }` (el `type` es la routing key del exchange `reservas.events`, de tipo *topic*). Los contratos están en `reservation-events.ts` (reservations) y `events/payment-events.ts` (payments).

### payments-service

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| GET | `/payments/by-reservation/:reservationId` | quien reservó | Pago de una reserva |
| GET | `/payments/:id` | quien reservó | Detalle |
| POST | `/payments/:id/pay` | quien reservó | Cobra la seña. **`Idempotency-Key` obligatorio**. 200 (resuelto) o 202 (la pasarela avisará por webhook) |
| POST | `/webhooks/gateway` | la pasarela (firma HMAC, sin JWT) | Resultado de cobros asíncronos |
| GET | `/health` | público | Base y RabbitMQ |

Estados del pago: `PENDING → PROCESSING → SUCCEEDED → REFUNDED`, o `FAILED`, `EXPIRED`, `CANCELLED`.

### Decisiones de diseño

- **Idempotency-Key en la misma transacción que el cobro.** Si dos pedidos con la misma clave llegan a la vez, el segundo `INSERT` espera (lo serializa PostgreSQL) y después recibe la respuesta guardada: un solo cobro, sin estado "en proceso" ni locks propios. Si el proceso muere a mitad, todo se revierte y la clave queda libre. La misma clave con otro pedido → 422. Los errores 4xx se guardan y se repiten; los 5xx no (para poder reintentar). Además la pasarela recibe una clave estable por pago (`pay-<id>`): aunque algo falle entre el cobro y el guardado, reintentar no cobra dos veces.
- **Un pago se cobra bajo un lock de su fila** (`SELECT … FOR UPDATE`): dos intentos simultáneos con claves distintas se ejecutan en fila y el segundo recibe 409.
- **Pasarela detrás de una interfaz (`PaymentGateway`)**: `createCharge`, `parseWebhook` (verifica firma) y `refund`. Hoy hay una **pasarela simulada** con tokens de prueba y webhooks reales firmados. Como aprueba cualquier pago de prueba, con `NODE_ENV=production` el servicio **no arranca** con ella salvo que se ponga `ALLOW_SIMULATED_GATEWAY=true` (el `.env.example` lo trae en `true` para desarrollo y e2e). Para sumar **Mercado Pago** (o Stripe): escribir un `MercadoPagoGateway implements PaymentGateway`, agregar su rama en `gateway/gateway.module.ts` y poner `PAYMENT_PROVIDER=mercadopago` con sus credenciales. El resto del servicio no cambia. (Los tokens `tok_*` se reemplazan por el token que genera el SDK del navegador.)
- **Webhooks**: firma HMAC-SHA256 con timestamp (`t=…,v1=…`), comparación en tiempo constante y tolerancia de 5 min contra repeticiones; se verifica sobre el **cuerpo crudo** (`rawBody`). Cada evento se deduplica por su id. Si el cobro todavía no existe (llegó antes de confirmarse el pedido), responde 404 y revierte, así la pasarela reintenta.
- **Compensaciones**: pago rechazado → la reserva se cancela y la mesa vuelve a estar libre. Pago aprobado que llega cuando la reserva ya venció o se canceló → `reservation.refund_requested` → reembolso. Cancelación → reservations decide `refundable` (política de 24 h) y payments solo ejecuta.
- **Mensajes desordenados**: si llega un evento sobre un pago que todavía no existe, se reintenta con demora (no es "veneno"): da tiempo a que llegue `reservation.created`.
- **Vencimiento**: un `UPDATE … RETURNING` cada `EXPIRATION_CHECK_MS`; con varias instancias, cada reserva vence una sola vez.
- **Esquema de la base**: todavía no hay migraciones; los servicios usan `synchronize` de TypeORM. Como las imágenes corren con `NODE_ENV=production` (donde está apagado), `docker-compose.yml` pone `DB_SYNCHRONIZE=true`. En producción de verdad se reemplaza por migraciones.
- **Reservas con pago en proceso (`PROCESSING`)** no se tocan al cancelarse o vencer: manda el resultado del webhook (y si se aprobó, se devuelve).

### Limitaciones conocidas

- **No hay conciliación**: si la pasarela cobra y nunca avisa (webhook perdido sin reintentos), el pago queda `PROCESSING`. Una pasarela real ofrece consultar el cobro; falta un proceso que lo haga periódicamente.
- Una **DLQ** no tiene todavía quien la reprocese ni alarma: hoy se mira en el panel de RabbitMQ.
- La pasarela simulada guarda su idempotencia en memoria (se pierde al reiniciar); una real la guarda ella.
- El código de mensajería está **copiado** en reservations y payments (y los tests también): es candidato a paquete compartido, igual que seguridad y observabilidad.
- El orden de los eventos no está garantizado (por los reintentos): los consumidores están escritos para tolerarlo.
- `notifications-service` (avisar al cliente por mail/push al confirmarse) queda para después: los eventos ya están publicados.
- Sin Docker en mi entorno de desarrollo, no pude probar `docker compose up` ni las imágenes; sí probé todo con RabbitMQ 3.12 y PostgreSQL 16 reales y los servicios corriendo como procesos.

## Fase 7: frontend (`apps/web`)

React 19 + TypeScript + Vite + Tailwind CSS 4. Habla **solo con el BFF**, a través de `/api` (Vite en desarrollo y nginx en la imagen reenvían `/api/*` al BFF; así el navegador usa un único origen y no hace falta CORS).

```bash
npm run dev:web        # http://localhost:5173 (necesita el BFF y el resto andando)
npm test -w web        # 40 tests (Vitest + Testing Library)
npm run build -w web   # tsc + vite build
```

Con `npm run up` el frontend también se levanta en http://localhost:5173 (contenedor `web`, nginx).

**Para ver algo hace falta un restaurante cargado.** Seguí los pasos 1 y 2 de «Probar el flujo completo» (dueño + restaurante con horarios y mesas, y algún plato en la carta) y después entrá al frontend como cliente.

### Pantallas

| Ruta | Qué hace |
|---|---|
| `/` | Busca restaurantes por nombre y cocina (la búsqueda y la página viven en la URL) |
| `/restaurantes/:id` | Datos, **horarios libres** según personas y día, carta y botón para reservar |
| `/ingresar` | Login y registro (vuelve a donde se quería ir) |
| `/reservas/:id/pagar` | Paga la seña con los medios de prueba de la pasarela simulada; muestra el tiempo que queda de mesa retenida |
| `/reservas` | Mis reservas con filtro por estado, pago de la seña y cancelación con confirmación |
| `/panel` | **Dueño**: reservas del local por día y estado, «Asistió» / «No vino» y cancelar (ver «Panel del dueño») |
| `/panel/restaurantes/nuevo`, `/panel/restaurantes/:id` | **Dueño**: crear / editar / eliminar un restaurante con sus mesas y horarios |
| `/panel/restaurantes/:id/carta` | **Dueño**: agregar, editar, pausar y quitar platos (precio, alérgenos, variantes) |

### Dónde vive cada tipo de estado (y por qué)

| Herramienta | Qué guarda | Por qué ahí |
|---|---|---|
| **React Query** (`src/api/hooks.ts`) | Todo lo que viene del servidor: restaurantes, horarios libres, reservas, pagos | Caché, "cargando/error", reintentos y refresco al volver a la pestaña vienen resueltos. Las claves están en un solo lugar para invalidar con precisión (al cancelar se refrescan las reservas y los horarios libres, no los restaurantes) |
| **Context** (`src/auth/AuthContext.tsx`) | La sesión (usuario y token) | Casi cualquier componente la lee y cambia muy poco (login/logout) |
| **Redux Toolkit** (`src/store`) | El **borrador de la reserva** (personas, día, horario elegido, notas) y los avisos (toasts) | El borrador es estado del cliente que tiene que sobrevivir a la navegación: elegís un horario sin sesión, vas a ingresar, volvés y sigue elegido |
| **Estado local** (`useState`) | Cosas de una sola pantalla: qué medio de pago está marcado, si se está confirmando una cancelación | No hace falta compartirlo |
| **URL** (`useSearchParams`) | Búsqueda, filtros y página | Se puede compartir, recargar y volver con "atrás" |

### Decisiones que vale la pena mirar

- **El pago es el lugar donde un frontend ingenuo cobra dos veces.** La clave `Idempotency-Key` se genera por intento de pago y se **conserva** si el pedido falla por red o por la pasarela (reintentar es seguro: el servidor devuelve lo mismo); solo cambia si se cambia el medio de pago, porque el backend rechaza la misma clave con otro contenido. Los `POST` nunca se reintentan solos (`mutations.retry: false`). Hay tests para las dos reglas.
- **La confirmación es asíncrona** (llega por evento de RabbitMQ), así que justo después de pagar la reserva puede seguir en `PENDING_PAYMENT` unos instantes. La pantalla de pago consulta cada 2 s mientras el resultado todavía puede cambiar (`PROCESSING`, o pago ya resuelto con reserva todavía sin actualizar) y no deja pagar de nuevo mientras tanto.
- **Si alguien se llevó el horario antes que vos** (409), se deselecciona el horario, se muestra el motivo y se piden de nuevo los libres.
- **Los errores se muestran, no se esconden**: el cliente de la API (`src/lib/api.ts`) convierte cualquier falla en un `ApiError` con un mensaje legible (los 5xx nunca muestran detalles técnicos) y el código de seguimiento (`x-correlation-id`) para buscar el pedido en Grafana. Un 401 con sesión cierra la sesión y limpia la caché (no se ve nada del usuario anterior).
- **Fechas y montos**: los horarios se muestran en la zona del restaurante (no la del navegador) y el dinero viaja en centavos.
- **Accesibilidad básica**: etiquetas en todos los campos, foco visible, regiones `aria-live` para los resultados, respeta `prefers-reduced-motion`, botones de al menos 44 px.
- **Diseño**: la reserva se muestra como una *comanda* (el ticket del mozo, con su borde perforado); es el único adorno de la app.

### Responsive

Se diseñó de móvil hacia arriba: sin prefijo es una columna, y `sm:`, `md:` y `lg:` suman columnas. Se revisó pantalla por pantalla con capturas a 320, 375 y 768 px, midiendo además que la página nunca tenga scroll horizontal. Lo que se corrigió y por qué:

- **Header**: en móvil bajaba a tres filas. Ahora el logo y la sesión van arriba y la navegación abajo, en su propia fila (si no entra, se desliza de costado). El nombre largo se corta con `…`.
- **Grilla del `Layout`**: la columna era `auto` y se ensanchaba hasta el ancho de los links en una sola línea, lo que desbordaba la página a 320 px. Se fijó con `minmax(0, 1fr)`: es el clásico problema de que un hijo de una grilla nunca se achica por debajo de su contenido.
- **Resumen del día**: con 7 tarjetas en 2 columnas quedaba una huérfana. "Todas" ocupa el ancho completo y las otras seis forman filas parejas (2 columnas en móvil, 3 en tablet, 7 en escritorio).
- **Formulario del restaurante**: cada mesa y cada turno son una tarjeta con campos en dos columnas (en escritorio siguen en una línea). Antes eran 4 controles apilados en zigzag por turno.
- **Fila de reserva del panel**: la hora y el nombre van lado a lado en vez de una arriba de la otra.

Limitación: a 320 px (celulares muy chicos) el último link de la navegación queda apenas cortado y hay que deslizar. No hay un test automático de responsive: jsdom no calcula layout, así que se verificó con un navegador real.

### Limitaciones conocidas

- **El panel del dueño cubre reservas, restaurante y carta** (ver «Panel del dueño»); incluye el resumen del día.
- El **token se guarda en `localStorage`**: sobrevive al F5 pero un script malicioso (XSS) podría leerlo. Lo más seguro sería que el BFF lo entregue en una cookie `httpOnly`.
- Los **tests** cubren la lógica y las pantallas con un servidor falso (`fetch` simulado); no hay todavía pruebas con un navegador real contra el stack (lo recorrí a mano con Playwright, pero ese script no está en el repo).
- Sin Docker en mi entorno de desarrollo no pude probar la imagen `web` ni la configuración de nginx; sí probé el build de la imagen paso a paso (instalación aislada + `npm run build`) y el frontend contra los servicios reales con `npm run dev`.
- Solo tema claro; sin traducciones (todo en español rioplatense).

## Panel del dueño (`/panel`)

El dueño de un restaurante ve las reservas de su local, marca si el cliente fue, puede cancelar y **crea, edita y elimina sus restaurantes** (datos, mesas y horarios) **administra su carta** y ve un **resumen del día**. Alcance deliberadamente acotado: el resumen cuenta reservas por estado (no comensales, ocupación por hora ni señas).

| Pieza | Qué se agregó |
|---|---|
| auth-service | El JWT ahora lleva `name` |
| reservations-service | Columna `customer_name` (nullable), copiada del token al reservar y devuelta en la API |
| restaurants-service | `GET /restaurants/mine` (rol `RESTAURANT_OWNER`, sin caché, ordenado por nombre) |
| web-bff | Módulo `owner`: `GET /owner/restaurants`, `GET /owner/restaurants/:id/reservations`, `PATCH /owner/reservations/:id/status` |
| web-bff (carta) | `GET /owner/restaurants/:id/menu` (con los pausados), `POST` y `PATCH`/`DELETE …/menu-items/:itemId` |
| web-bff (gestión) | `POST /owner/restaurants`, `PATCH` y `DELETE /owner/restaurants/:id`: validan la forma del cuerpo (mismas reglas que el servicio) y reenvían |
| apps/web | `/panel` (con `RequireOwner`), link «Panel del local» solo para dueños, y el formulario de restaurante en `/panel/restaurantes/nuevo` y `/panel/restaurantes/:id` |

### Qué se puede hacer según el momento de la reserva

| Estado | Todavía no empezó | Ya empezó |
|---|---|---|
| `CONFIRMED` | **Cancelar** (se devuelve la seña) | **Asistió** / **No vino** |
| `PENDING_PAYMENT` | solo se ve (el cliente todavía puede pagar) | — |
| Resto | solo se ve | solo se ve |

Esas reglas las impone reservations-service (`cancel` falla si ya comenzó; `status` falla si todavía no); la pantalla solo ofrece el botón que va a funcionar.

### Decisiones que vale la pena mirar

- **El nombre del cliente viaja en el JWT y se guarda en la reserva** (en vez de que el servicio de reservas le pregunte a auth-service). Evita una dependencia nueva entre servicios y una llamada por listado. Se guarda **solo el nombre**: sin email ni teléfono, para exponer lo mínimo al dueño.
- **El nombre es una copia**: si el cliente cambia su nombre después, la reserva conserva el de ese momento (es lo que el local vio al reservar). Hoy no hay forma de cambiarlo, así que no es un caso real todavía.
- **Tokens viejos y reservas viejas**: un token emitido antes del cambio no trae `name` (el campo es opcional en los servicios) y esa reserva queda con `customer_name = NULL`; el panel muestra «Cliente». Con volver a iniciar sesión alcanza. Las reservas anteriores no se completan solas.
- **El BFF no duplica permisos**: reenvía y deja que cada servicio decida (restaurants-service para «mis restaurantes», reservations-service para las reservas de *ese* local). Un cliente o un dueño ajeno recibe el 403/404 del servicio. `RequireOwner` en el front solo evita mostrar una pantalla que iba a fallar; no es seguridad.
- **`/restaurants/mine` va antes que `/restaurants/:id`** en el controlador; si no, Nest interpretaría «mine» como un id.
- **Cancelar reutiliza `POST /reservations/:id/cancel`**: ese endpoint ya aceptaba al dueño, y el evento ya marca `CANCELLED_BY_OWNER` con devolución de la seña.

### Gestión del restaurante: decisiones

- **Los cambios sobre mesas y horarios no revalidan las reservas existentes.** Es el comportamiento del backend; el formulario lo avisa en pantalla al editar. Bloquear el cambio si hay reservas futuras afectadas exigiría que restaurants-service consulte a reservations-service (una dependencia nueva entre servicios) y quedó fuera.
- **Eliminar no cancela las reservas.** Se borra el restaurante y su carta; las reservas quedan apuntando a un restaurante que ya no existe. La confirmación lo dice y pide cancelar antes las vigentes desde el panel.
- **Validación en tres capas**: el formulario avisa al instante (`lib/restaurantForm.ts`, mismas reglas que el servidor), el BFF rechaza la forma inválida sin molestar al servicio, y restaurants-service decide lo que depende de los datos (mesas repetidas, quién es el dueño).
- **Todo el formulario es texto hasta enviarlo**: los campos numéricos se convierten recién al enviar, así que se puede borrar y reescribir un número sin que salte a `0`.
- **Mutaciones que refrescan lo correcto**: tras crear, editar o eliminar se invalidan mi lista, el listado público y el detalle, y en el servidor el caché de Redis se invalida solo (Fase 8).
- El teléfono vacío **no se envía** (el servidor lo rechaza por formato), así que una vez cargado no se puede dejar en blanco desde la pantalla.

### El resumen del día: decisiones

- **Siete tarjetas que también son filtros**: el total del día y un número por estado (confirmadas, por pagar, asistieron, no vinieron, canceladas, vencidas). Tocar una filtra la lista de abajo, así que el resumen y el listado son una sola pantalla y no hay que aprender dos controles. Reemplaza a los botones de filtro de antes.
- **El conteo se hace en la base, no en el navegador ni en el BFF**: `GET /reservations/restaurant/:id/summary?date=` ejecuta un `GROUP BY status` en Postgres. La lista está paginada (máximo 50 por página), así que sumarla desde afuera se cortaría con un día grande; la consulta agregada cuesta lo mismo con 10 reservas que con 1.000.
- **Mismo «día» que el listado**: es el día calendario en la zona horaria del restaurante (medianoche de Buenos Aires, no de UTC). Los dos endpoints comparten la función que calcula el rango, para que no puedan diferir; el e2e verifica que cada número coincide con el total del listado filtrado por ese estado.
- **Los seis estados siempre están, en 0 si no hay**: la pantalla no tiene que adivinar cuáles faltan. `COUNT` llega de Postgres como texto (es un `bigint`) y se convierte en el servicio.
- **Mismos permisos que el listado**: solo el dueño de ese restaurante (si no, 404). La fecha es obligatoria.
- **Si el resumen falla, la pantalla sigue siendo útil**: la lista y los filtros funcionan igual y los números se muestran como «–». Los números se actualizan solos al marcar una reserva, cancelarla o volver a la pestaña.

### La carta: decisiones

- **Los precios se escriben en pesos y viajan en centavos enteros.** El formulario acepta coma o punto (`4500,50`) y convierte con redondeo (`19,99` × 100 da `1998,999…` en coma flotante; se redondea a `1999`). Un monto inválido o con más de dos decimales se rechaza antes de enviarlo (`lib/menuForm.ts`). Editar un plato y guardarlo sin tocar nada **no cambia** su precio (hay un test).
- **Pausar no es borrar**: un plato pausado (`available: false`) desaparece de la carta pública pero el dueño lo sigue viendo, marcado, y lo reactiva con un clic. Mandar solo `available` evita pisar el resto de los datos.
- **Alérgenos como casillas** (los 14 códigos del servidor, mostrados en español) y **variantes** con diferencia de precio, que puede ser negativa.
- **Categorías libres con sugerencias**: se escribe la categoría y se sugieren las que ya existen (`datalist`), así no aparece «Postres» y «postres» por un descuido.
- **El caché no sirve cartas viejas**: cada cambio invalida la carta de Redis (Fase 8) y el front refresca la del dueño y el detalle público. El e2e lo comprueba: se pausa un plato y desaparece de la carta pública al instante.
- **Arreglo de paso**: `formatMoney` redondeaba a pesos enteros, así que un plato de `$ 4.500,50` se mostraba como `$ 4.501`. Ahora muestra los centavos solo si existen (`$ 4.500` o `$ 4.500,50`). Afecta también la carta pública y las señas.

### Cómo se probó

- Tests unitarios y HTTP en los cuatro servicios, 8 tests de pantalla (`OwnerPage.spec.tsx`: acceso por rol, filtros, marcar asistencia, cancelar con confirmación, error del servidor, paginación).
- La integración de reservations-service (Postgres y RabbitMQ reales) verifica que `customerName` se guarda desde el token.
- La prueba de punta a punta tiene dos secciones nuevas: «8. Panel del dueño» (lista, nombre del cliente, filtro por día, dueño ajeno, marcar antes de hora, cancelar) y «9. Gestión de restaurantes» (crear, editar, ver el cambio al instante pese al caché, dueño ajeno, eliminar).
- 19 tests más de pantalla y de reglas del formulario de restaurante (alta, errores, mesas repetidas, edición, baja con confirmación) y 18 de la carta (conversión de precios, validación, alta, edición, pausa, baja y errores).
- El resumen: 5 tests unitarios y 4 HTTP en reservations-service, 3 de integración con Postgres real (la consulta agregada y el día en la zona del restaurante), 2 en el BFF y 4 de pantalla. El e2e suma «11. Resumen del día».
- La prueba de punta a punta suma «10. Carta del dueño»: alta, validación (alérgeno inventado, precio con decimales), dueño ajeno, pausa y reactivación con la carta pública al día, baja.
- Recorrido en un navegador real con Playwright contra el stack (con un restaurants-service simulado, sin MongoDB real): sin errores de consola.

### Limitaciones conocidas

- **El endpoint público de la carta acepta `?includeUnavailable=true` sin autenticación** (así lo definió restaurants-service), por lo que quien conozca el parámetro puede ver los platos pausados. No son datos sensibles, pero conviene restringirlo si se pausan por un motivo interno.
- La carta no tiene **orden manual**: se ordena por categoría y nombre. Tampoco hay fotos de los platos.
- El selector de restaurante aparece solo si hay más de uno; con dos locales de igual nombre no se distinguen.
- No hay filtros por rango de fechas ni por nombre del cliente; el listado y el resumen son por **un día**.
- El resumen **cuenta reservas, no comensales**: no suma las personas de cada reserva, ni muestra ocupación por franja horaria ni el monto de las señas. Sería sumar columnas a la misma consulta agregada.
- Las reservas de varios locales no se juntan en una sola vista.
- El panel no se actualiza solo: refresca al volver a la pestaña o al tocar una acción.
- `DB_SYNCHRONIZE` crea la columna nueva automáticamente; en producción haría falta una migración.

## Fase 8: performance (Redis, k6, Lighthouse)

La regla de esta fase: **no se optimiza nada sin medir antes y después**. Se midió el front con Lighthouse y el backend con k6 (resultados abajo; el kit para repetirlo está en `perf/README.md`).

### Caché de lecturas con Redis (`restaurants-service/src/cache`)

Los datos que más se piden (listado, detalle de un restaurante, carta) cambian poco: cada pedido iguala a los anteriores y MongoDB repite el mismo trabajo. Se aplicó el patrón **cache-aside**: se mira Redis; si está (*hit*) se responde desde ahí; si no (*miss*) se consulta MongoDB, se guarda con vencimiento y se responde.

| Pedido | ¿Se cachea? | Por qué |
|---|---|---|
| `GET /restaurants` (sin `search`) | Sí, por página y filtro de cocina | Es la portada: se repite todo el tiempo |
| `GET /restaurants?search=...` | **No** | El texto lo escribe cada usuario: hay infinitas combinaciones y casi no se repiten; llenarían Redis de claves inútiles |
| `GET /restaurants/:id` | Sí | Lo usan el BFF y reservations-service en cada reserva |
| `GET /restaurants/:id/menu` | Sí (con y sin platos no disponibles, por separado) | Es la parte más pesada de la pantalla de un restaurante |
| Disponibilidad de mesas (reservations-service) | **No** | Cambia con cada reserva: un dato viejo permitiría ofrecer una mesa ocupada |

### Decisiones que vale la pena mirar

- **Invalidación por versión.** Todas las claves llevan un número de versión (`restaurants:v7:...`). Cuando alguien crea, modifica o borra un restaurante o un plato, se incrementa ese número y las claves anteriores quedan fuera de alcance (se limpian solas por vencimiento). Es más simple que buscar y borrar claves una por una, y además evita una carrera: una lectura lenta que empezó antes de la escritura guarda su dato viejo bajo la versión vieja, que ya nadie consulta.
- **Se invalida después de escribir, no antes**, y solo si la escritura tuvo éxito (un 403 o un 404 no invalidan).
- **Redis es una optimización, no una dependencia.** Si se cae o tarda, el pedido se resuelve desde MongoDB (tiempos cortos y sin cola de espera). Si falta `REDIS_URL`, el servicio anda igual que antes de la fase. Esto además permite medir "sin caché" con el mismo código.
- **Una sola consulta por clave** (*single-flight*): si llegan 100 pedidos juntos por algo que no está en el caché, solo uno va a MongoDB y los otros esperan ese resultado. Evita la «estampida» cuando vence una clave popular.
- **Los errores no se cachean** (un 404 de hoy no puede ser un 404 de mañana).
- **Vencimiento de 60 s** (`CACHE_TTL_SECONDS`): red de seguridad por si alguna escritura se hiciera sin pasar por el servicio.
- Redis en Docker: sin persistencia, 64 MB como máximo y `volatile-lru` (si se llena, descarta solo claves con vencimiento, las menos usadas; la clave de versión no vence, así que nunca se descarta).

### Cómo se probó

- 14 tests unitarios del caché (aciertos, vencimiento, invalidación, la carrera descrita arriba, 100 pedidos simultáneos, Redis caído, valor corrupto) y tests de que cada servicio cachea lo que debe e invalida cuando debe.
- 15 tests de integración contra un **Redis real** (`npm run test:integration -w restaurants-service`, también en el CI), incluyendo uno de punta a punta por HTTP que cuenta cuántas veces se consulta la base. Verifiqué que las pruebas fallan si se rompe la invalidación, la versión o la deduplicación.
- En la prueba de punta a punta (`npm run test:e2e`) hay una sección nueva: después de agregar un plato o renombrar el restaurante, el BFF tiene que mostrar el dato nuevo enseguida.

### Resultados del front (Lighthouse, móvil simulado, mediana de 5 corridas)

Medido en mi entorno con la app construida y servida por nginx con la misma configuración de la imagen. Los valores absolutos dependen de la máquina; lo que importa es la diferencia.

| | Listado antes | Listado después | Detalle antes | Detalle después |
|---|---:|---:|---:|---:|
| Performance (0-100) | 85 | **98** | 90 | **98** |
| First Contentful Paint | 3,2 s | **1,9 s** | 2,8 s | **1,6 s** |
| Largest Contentful Paint | 3,4 s | **1,9 s** | 3,0 s | **2,1 s** |
| Datos transferidos | 441 KB | **189 KB** | 441 KB | **189 KB** |
| SEO | 82 | **100** | 82 | **100** |
| Accesibilidad / Buenas prácticas | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 |

Qué lo causó, en orden de impacto (cada cambio se midió por separado):

1. **Compresión gzip en nginx** (seis directivas en `apps/web/nginx.conf`): Performance 85 → 99 y FCP 3,2 → 1,7 s. El JS y el CSS son texto y se achican ~70 %; sin compresión el navegador bajaba los 354 KB del bundle completos.
2. **`robots.txt` y `meta description`**: SEO 82 → 100. Sin `robots.txt`, nginx devolvía `index.html` (el comodín de la app de una sola página) y los buscadores lo leían como reglas inválidas.
3. **Probado y descartado: dividir el código por rutas** (`React.lazy`). Ahorraba unos 5 KB comprimidos en la carga inicial y no se notó en las medidas: las pantallas pesan muy poco, el grueso del bundle son las librerías (React). No justificaba la complejidad extra (más pedidos, estados de carga, tests más complicados).

### Resultados del backend (k6)

Medido en una PC con Windows y Docker Desktop, con **todo en la misma máquina** (servicios, bases, Redis y el propio k6), 150 restaurantes con 30 platos cada uno y una corrida por caso (10 s de calentamiento + 30 s medidos). El tráfico simula gente navegando: 45 % listados, 45 % pantalla de un restaurante, 10 % búsquedas por texto.

**1. Capacidad: 100 pedidos por segundo.** Sin caché el sistema se satura; con caché aguanta.

| | Sin caché | Con caché |
|---|---:|---:|
| Pedidos fallidos | 7,8 % | **0 %** |
| Mediana (p50) de todos los pedidos | 496 ms | **6,9 ms** |
| p95 de todos los pedidos | 6.138 ms | **28 ms** |
| Pedidos que k6 no llegó a iniciar | 322 | 44 |

Los ~6 s del «antes» coinciden con el BFF esperando 3 s a `restaurants-service` y reintentando una vez: los pedidos fallidos son timeouts por saturación. Con caché la mayoría de las lecturas ni llega a MongoDB, y esa carga que se evita también alivia a las búsquedas (que no usan el caché): por eso en esta tabla la búsqueda también mejora. **A esta carga la búsqueda deja de ser un control limpio.**

**2. Latencia con carga baja: 30 pedidos por segundo** (ninguno de los dos modos se satura, así que la comparación es justa).

| Pedido | p50 antes | p50 después | p95 antes | p95 después | Cambio p95 |
|---|---:|---:|---:|---:|---:|
| Listado (cacheado) | 9,0 ms | 5,8 ms | 17,6 ms | 10,0 ms | -43 % |
| Pantalla de restaurante (cacheado) | 14,4 ms | 7,7 ms | 24,3 ms | 21,3 ms | -12 % |
| Búsqueda por texto (**no** cacheado, control) | 9,5 ms | 10,0 ms | 19,3 ms | 17,6 ms | -9 % |
| Todos juntos | 12,2 ms | 7,0 ms | 22,2 ms | 18,4 ms | -17 % |

Cómo leerlo:

- **La mejora de latencia con poca carga es real pero chica**: la mediana del listado y de la pantalla de restaurante baja entre un 35 % y un 47 %, o sea unos 3 a 7 ms. Con pocos datos y MongoDB en la misma máquina, la base ya responde en pocos milisegundos y no hay mucho que ahorrar.
- **La búsqueda (que no usa caché) casi no se movió** (+5 % en la mediana, -9 % en el p95): esa diferencia es el nivel de ruido de la medición. Por eso las diferencias de p95 de ese tamaño (como el -12 % de la pantalla de restaurante) no se pueden distinguir de la suerte; las medianas sí.
- **Donde el caché pesa de verdad es en la capacidad**: pasar de 7,8 % de errores y 6 s de espera a 0 % de errores y 28 ms a 100 pedidos por segundo.

**3. Qué dijo Redis** (`keyspace_hits` 13.604, `keyspace_misses` 714). Ojo con este número: cada lectura consulta Redis **dos veces** (primero la versión del caché y después el dato), así que la tasa de aciertos de 95 % que sale de esa cuenta está inflada. Contando solo los datos, es de alrededor de 90 %. Los ~700 fallos son esperables: unas 330 claves distintas (150 detalles, 150 cartas y las páginas del listado) que hubo que cargar al empezar y volver a cargar cuando vencieron a los 60 s.

**Salvedades**: una sola corrida por caso (no se repitió para medir la variación entre corridas en esta máquina); k6 comparte CPU con los servicios, y aun con caché a 100 pedidos por segundo quedaron 44 sin iniciar, así que ese es más o menos el techo de esta PC; el tráfico repite pocas páginas, un mejor caso que el real (con miles de restaurantes la tasa de aciertos sería menor).

### Un bug real que apareció al medir

Al correr Lighthouse sobre la pantalla de un restaurante con carta, la consola del navegador mostró un error: el front esperaba la carta como una lista plana de platos, pero `restaurants-service` la devuelve **agrupada por categoría** (`[{ category, items: [...] }]`). Los tests del front simulaban la forma equivocada y por eso no lo detectaron. Se corrigió el front, se agregó un test con una carta real y una sección en el e2e que verifica la forma de la respuesta del BFF. La lección: los tests que simulan al otro lado solo prueban lo que uno *cree* que devuelve; hace falta al menos una prueba contra el servicio real.

### Limitaciones conocidas

- **Las mediciones del backend son de una sola máquina y una sola corrida por caso** (ver las salvedades arriba); los números absolutos no se pueden extrapolar a otro entorno. Los de Lighthouse son de un entorno simulado.
- El caché es invalidación global: cualquier escritura descarta todo. Es correcto y simple porque se edita muy poco comparado con lo que se lee; con un panel de dueños muy activo habría que invalidar por restaurante.
- La página sigue renderizándose en el navegador (SPA): el contenido aparece después de bajar el JS y pedir los datos. Mejorarlo más exigiría renderizado en el servidor o prerenderizado, que es otro proyecto.
- No hay caché en el BFF ni en el navegador para las llamadas a la API (por ejemplo, `Cache-Control`/ETag). Es el siguiente paso natural si la medición muestra que hace falta.

## Fase 9: CI/CD (GitHub Actions)

Todo vive en `.github/` y **tiene que estar en la raíz del repositorio** (el repo es la carpeta `reservas-platform`, no una carpeta más arriba).

### `ci.yml`: se corre en cada pull request (y cuando lo llama `release.yml`)

No se dispara con cada `push` a una rama: los commits sueltos no gastan minutos, y lo que cuenta es el estado del pull request. Si hay un PR abierto y subís otro commit, la corrida anterior se cancela (`concurrency`).

| Job | Qué verifica | Detalle |
|---|---|---|
| **Lint** | `npm run lint` sobre todo el repo, con cero avisos permitidos | Un solo job (la configuración es única). Corre en paralelo a los demás |
| **Unitarios** (×7) | Compila (con chequeo de tipos) y corre los tests de `auth`, `restaurants`, `reservations`, `payments`, `notifications`, `web-bff` y `web` | Un job por paquete, en paralelo y con `fail-fast: false`: si uno falla se ve igual el estado de los demás. Usa `npm ci`, que instala exactamente lo del `package-lock.json` |
| **Integración** (×2 + 1) | `reservations` y `payments` contra **PostgreSQL 16 y RabbitMQ reales**; `notifications` contra RabbitMQ real (job aparte, no usa PostgreSQL) | Los lanza como *service containers* con los puertos y credenciales que esperan los tests |
| **Integración del caché** | El caché de `restaurants-service` contra un **Redis real** | Prueba la invalidación, que dos instancias compartan el caché y que, si Redis se cae, el servicio siga respondiendo |
| **Imagen** (×7) | Que cada `Dockerfile` construya | Con caché de capas: si las dependencias no cambiaron no se reinstalan |
| **Punta a punta** | Levanta **todo** con `docker compose` (bases, RabbitMQ, 6 servicios y el front) y corre la saga de la seña a través del BFF | Es lo único que prueba la red entre contenedores y el proxy de nginx. Si falla, sube los logs de todos los contenedores |
| **Auditoría** | `npm audit` de las dependencias de producción | **Avisa pero no bloquea**: el paso siempre termina bien, y si hay vulnerabilidades altas deja un aviso amarillo y el detalle en el resumen de la corrida. Se hizo así porque `continue-on-error` igual pinta el commit de rojo. Hoy la auditoría de producción da **0 vulnerabilidades** (ver «Versión de NestJS») |

Los secretos de la corrida punta a punta (`JWT_SECRET`, `GATEWAY_WEBHOOK_SECRET`) se generan al azar en el mismo job y se descartan: no hay que cargar nada en GitHub para que el CI ande.

### `release.yml`: se corre al hacer push a `main` o al crear un tag `vX.Y.Z`

1. Llama al CI completo (`uses: ./.github/workflows/ci.yml`). **Si algo falla, no se publica nada.**
2. Construye las 6 imágenes y las sube a GitHub Container Registry: `ghcr.io/<usuario>/<repo>/<servicio>`.
3. Etiquetas: `latest` y `sha-<commit>` en cada push a `main`; además `X.Y.Z` y `X.Y` si hay tag. La etiqueta `sha-…` permite volver a una versión exacta.

Para publicar una versión: `git tag v0.1.0 && git push origin v0.1.0`.

### Decisiones de seguridad

- **Permisos mínimos**: el workflow completo tiene `contents: read`; solo el job `publish` agrega `packages: write`.
- **Sin secretos propios**: se publica con el `GITHUB_TOKEN` temporal de cada corrida.
- Las imágenes quedan **ligadas al commit** (etiquetas OCI), y las corridas de `main` y de tags no se cancelan entre sí: cada commit publicado quedó probado.
- **Dependabot** propone actualizaciones de npm (menores y parches en un solo PR por semana), de las acciones y de las imágenes base; el CI las prueba antes de poder mergearlas.

### Configurar en GitHub (una sola vez)

1. **Settings → Actions → General → Workflow permissions**: dejá «Read repository contents» (los permisos de escritura ya los pide el job que los necesita).
2. **Settings → Branches → Add rule** sobre `main`: *Require a pull request* y *Require status checks to pass* eligiendo los jobs del CI. Así no entra código que no pasó las pruebas.
3. Después del primer release, en el perfil → **Packages**, las imágenes aparecen como privadas; se pueden hacer públicas desde la configuración de cada paquete.
4. Para ver el estado en el README, agregá la insignia (cambiá `USUARIO/REPO`): `![CI](https://github.com/USUARIO/REPO/actions/workflows/ci.yml/badge.svg)`

### Limitaciones conocidas

- **Los workflows ya corrieron en GitHub**: el CI quedó en verde y `release.yml` publicó las 6 imágenes en GHCR. Antes de eso los había validado con *actionlint* y corriendo los mismos comandos en una copia limpia, pero la prueba real fue esa primera corrida.
- Las versiones de las acciones (`actions/checkout@v4`, `docker/build-push-action@v6`...) son las que conocía; Dependabot las mantiene al día.
- **No hay etapa de deploy**: se publican imágenes, pero no se despliegan a ningún servidor (todavía no hay un destino definido).
- Los Dockerfile usan `npm install` (no `npm ci`), así que las imágenes no usan el lockfile; el CI sí lo usa para las pruebas. Pasarlos a `npm ci` requiere construir desde la raíz del monorepo.

## Notificaciones (`notifications-service`)

Cuando una reserva cambia de estado por algo que el cliente **no hizo él mismo**, le llega un aviso a su bandeja (la campanita del encabezado y la pantalla `/notificaciones`):

| Evento | Aviso al cliente |
|---|---|
| `reservation.confirmed` | «Reserva confirmada» (restaurante, personas, fecha y hora) |
| `reservation.cancelled` por **pago rechazado** | «No se pudo cobrar la seña» |
| `reservation.cancelled` por **el restaurante** | «El restaurante canceló tu reserva» (y si la seña se devuelve o no) |
| `reservation.expired` | «Tu reserva venció» |
| `reservation.cancelled` por el propio cliente | *(nada: lo hizo él)* |

```
reservations ──(outbox)──▶ RabbitMQ ──reservas.events──▶ notifications ──▶ MongoDB (bandeja)
                                                              ▲
 React ──GET /notifications, PATCH /:id/read, POST /read-all──▶ BFF ──▶ ┘   (todo filtrado por el `sub` del JWT)
```

### Decisiones que vale la pena mirar

- **Los eventos llevan los datos para armar el mensaje** (nombre del restaurante, fecha, personas, zona horaria). Así `notifications` no llama a nadie por HTTP ni depende de que otro servicio esté en pie. El cambio fue **aditivo**: `payments` ignora los campos nuevos.
- **Idempotencia con un índice único**: RabbitMQ entrega «al menos una vez», así que un evento puede llegar dos veces. El índice único de `eventId` hace que solo cree una notificación; el segundo intento da error `E11000`, que se trata como «ya procesado» y no como falla.
- **Privacidad**: todo se filtra por el `sub` del JWT. La notificación de otra persona responde 404 (igual que una inexistente), para no revelar que existe.
- **Se borran solas a los 90 días** (índice TTL de Mongo): una bandeja no es un historial.
- **La campanita consulta cada 30 s** (polling), solo con sesión y con la pestaña visible. No hay websockets: para un contador alcanza y es mucho más simple.
- **Si `notifications` se cae**, las reservas siguen andando: los eventos esperan en la cola. El BFF marca su salud como `degraded` y la campanita simplemente no muestra número.
- La fecha se formatea en la **zona horaria del restaurante**, no en la del servidor (un contenedor corre en UTC).

### Cómo se probó

- Unitarios (127): plantillas de cada tipo, idempotencia, privacidad entre usuarios, filtros y paginación.
- Integración contra **RabbitMQ real** (9): evento → notificación, duplicados, reintento ante fallo transitorio, DLQ con el motivo y eventos que no le interesan al servicio.
- Verificaciones de que los tests detectan regresiones (rompiendo a propósito la idempotencia y el filtro por usuario).
- Frontend: 8 tests nuevos (campanita, lista, marcar una/todas, filtro, error) y revisión visual a 320, 390 y 1280 px.
- Punta a punta (`e2e/saga.e2e.mjs`, sección 12): pago aprobado, rechazado, cancelación del dueño y cancelación propia contra el sistema completo.

### Limitaciones conocidas

- **Los tests de integración no incluyen MongoDB**: simulan la bandeja en memoria. El comportamiento real de Mongo (índice único, TTL, `updateMany`) solo lo prueba la sección 12 del e2e con `docker compose`.
- No hay avisos por `payment.refunded` (la devolución de la seña) ni para el dueño del local.
- Solo bandeja en la app: sin email ni push.
- El código de mensajería (conexión a RabbitMQ, sobre del evento, reintentos) está **copiado** en cada servicio. Un paquete compartido está pendiente.

## Versión de NestJS y dependencias

Los servicios usan **NestJS 11** (venían de la 10). La auditoría de producción pasó de **14 vulnerabilidades (4 altas) a 0**: `multer`, `lodash`, `qs`, `body-parser`, `uuid` y `file-type` se arreglaron solos al subir `@nestjs/platform-express`, `@nestjs/swagger` y `@nestjs/typeorm`; la última, `js-yaml`, con un `overrides` en el `package.json` raíz.

**Por qué la 11 y no la 12** (la última): los paquetes de la 12 son solo ESM y Jest necesita Node 24.9 o más para cargarlos; hoy todo (CI, Dockerfiles, `engines`) usa Node 20. La 11 sigue siendo CommonJS, pide Node 20 y deja Jest 29 como está. Se decidió midiendo antes: la 11 ya cerraba 12 de las 14, y las 2 restantes (ambas `js-yaml`, a través de `@nestjs/swagger`) se resolvieron con el `override`. Migrar a la 12 queda para cuando se suba Node.

Qué había que revisar de la guía de migración y qué resultó:

| Cambio de la 11 | Nos afecta | Resultado |
|---|---|---|
| Express 5: rutas con `*`, `?` opcional, query parser simple | No: no hay rutas con comodines ni consultas anidadas | Sin cambios; los tests HTTP lo confirman |
| `Reflector.getAllAndOverride` puede devolver `undefined` | Los 5 `roles.guard` | Ya manejaban el caso; compila y los tests de roles pasan |
| Los hooks de cierre corren en orden inverso al de inicio | `RabbitConnection`, `OutboxRelay`, expiración, caché | Los tests de integración con RabbitMQ y Postgres reales pasan, y un `SIGTERM` cierra el proceso limpio |
| Módulos dinámicos ya no se deduplican | Tests con `TestingModule` | Sin efecto: los tests pasan sin cambios |
| `@nestjs/config` 4: orden de lectura | `ConfigService.get` | Sin efecto (solo leemos variables de entorno) |
| `@nestjs/jwt` 11 tipa `expiresIn` estricto (`'1h'`, `'7d'`) | `auth-service` (`JWT_EXPIRES_IN` viene del entorno) | Único cambio de código: un cast con nombre y comentario |

Una trampa que apareció: el `package-lock.json` viejo seguía fijando la 10 para las dependencias *peer* y quedaban **dos copias** de `@nestjs/common` (una por servicio), lo que rompe los tipos del compilador. Se regeneró el lockfile desde cero; `npm ls @nestjs/common` debe mostrar una sola versión.

Fuera de la auditoría de producción quedan avisos en herramientas de **desarrollo** (`vitest` 3→5 y `jest` 29→30 son versiones mayores). No llegan a ninguna imagen ni se ejecutan en producción; es una tarea aparte.

## Trazabilidad de logs

Una sola acción del usuario atraviesa varios servicios (BFF → reservations → restaurants). Cuando algo falla hay que poder responder: *¿qué le pasó a ESA request en cada servicio?*

```
 navegador ──x-correlation-id──► web-bff ──mismo id──► reservations-service ──mismo id──► restaurants-service
                                    │                          │                                │
                              logs JSON                    logs JSON                        logs JSON
                                    └────────────► Alloy ──► Loki ──► Grafana ◄───────────────┘
```

**Cómo funciona**
1. El BFF recibe (o genera) un `x-correlation-id` y lo devuelve en la respuesta. Lo reenvía en **cada** llamada a otro servicio, y estos hacen lo mismo con los suyos.
2. Dentro de cada servicio el id se guarda en un `AsyncLocalStorage` (una "variable global por request"), así que **cualquier log lo incluye solo**, sin pasarlo por parámetro y sin mezclar requests simultáneas.
3. Cada servicio escribe **una línea JSON por evento**: `{"timestamp","level","service","context","message","correlationId","userId", ...}`.
4. Cada request deja una línea `request completed` (método, ruta, status, duración) y cada llamada a otro servicio una línea `upstream call` (a quién, status, cuánto tardó). Así se ve **dónde se fue el tiempo**.
5. **Alloy** lee los logs (de los contenedores o de `./logs`), saca `service` y `level` como etiquetas y los manda a **Loki**. **Grafana** los consulta.

**Cómo verlo**

```bash
npm run obs:up                 # Loki, Alloy y Grafana
npm run up                     # los servicios en Docker; sus logs se leen solos
# ...o, si corrés los servicios con `npm run dev:*`, agregá LOG_DIR=../../logs a tu .env
# y reiniciá: cada servicio escribe además ./logs/<servicio>.log, que Alloy también lee.
```

Abrí http://localhost:3030 → carpeta **Reservas** → **Trazabilidad**. Hacé una request desde el Swagger del BFF, copiá el header `x-correlation-id` de la respuesta y pegalo en la variable **correlationId** de arriba: aparecen, en orden, los logs de todos los servicios que tocó esa request. El dashboard también muestra requests por minuto, errores 5xx, latencia p95 y las llamadas más lentas entre servicios.

Sin dashboard, en *Explore* de Grafana (consultas LogQL):

```logql
{app="reservas"} | json | correlationId="<el id>"                         # el recorrido de una request
{app="reservas", level="error"}                                           # errores
{service="web-bff"} | json | message="upstream call" | durationMs > 300   # llamadas lentas a otros servicios
{app="reservas"} | json | userId="<id de usuario>"                        # todo lo de un usuario
```

Para leer los logs en la terminal sin JSON: `LOG_FORMAT=pretty`. Para ver más detalle: `LOG_LEVEL=debug`.

### Decisiones de diseño

- **JSON, no texto**: Loki filtra por campo (`| json | status >= 500`) sin parsear texto con regex.
- **Etiquetas de Loki: solo `service`, `level` y `app`.** El `correlationId` NO es una etiqueta: tiene un valor distinto por request y Loki se vuelve lento con muchas combinaciones. Se busca en el contenido de la línea.
- **Lo que nunca se loguea**: query string, body ni headers de las requests. Además, el logger reemplaza por `[REDACTED]` cualquier campo que se llame `password`, `token`, `authorization`, `secret`, `cookie` o `apiKey`, aunque alguien lo agregue por error. Hay tests que lo verifican.
- **El id del cliente se acepta solo si es razonable** (8–100 caracteres alfanuméricos, `.`, `_` o `-`): evita que alguien inyecte basura o líneas falsas en los logs.
- **Los logs de `/health` van en nivel debug** para no llenar todo de ruido.
- **Retención de 7 días** en Loki, así el disco no crece sin límite.
- **El código de observabilidad está copiado en los 4 servicios** (`src/observability/`), igual que los guards y el filtro de errores. Ya son cuatro copias idénticas: es el momento de moverlo a un paquete compartido del monorepo.

### Limitaciones conocidas

- Son **logs correlacionados**, no *tracing distribuido* (OpenTelemetry/Tempo): no hay una vista de árbol con spans. Con los tiempos de `upstream call` se reconstruye casi lo mismo, pero a mano. OpenTelemetry sería el siguiente paso natural.
- No hay métricas (Prometheus) ni alertas.
- **Grafana está abierto sin login** (`GF_AUTH_ANONYMOUS_*`) para comodidad en desarrollo: no usar así fuera de tu máquina.
- Alloy necesita acceso al socket de Docker (solo lectura) para descubrir contenedores.
- La correlación con **mensajes asíncronos** (RabbitMQ) se resolvió en la Fase 6: el `correlationId` viaja dentro de cada evento (y en el header `x-correlation-id` del mensaje) y los consumidores lo restauran, así una saga completa se sigue con un solo id en Grafana.
- Sin Docker en mi entorno no pude probar la parte de contenedores (descubrimiento por socket, Grafana cargando el dashboard); sí probé Loki y Alloy reales leyendo archivos y todas las consultas del dashboard.

## Hoja de ruta

- [x] **Fase 1**: monorepo, `docker-compose`, `auth-service` con Swagger y tests
- [x] **Fase 2**: `restaurants-service` (MongoDB, carta)
- [x] **Fase 3**: `reservations-service` (disponibilidad, estados, concurrencia)
- [x] **Fase 4**: `web-bff` con validación de JWT y agregación de datos
- [x] **Fase 5**: trazabilidad (`x-correlation-id`, logs JSON, Loki + Grafana)
- [x] **Fase 6**: RabbitMQ, `payments-service` y saga de seña (idempotencia, compensaciones, DLQ)
- [x] **Fase 7**: frontend React (React Query, Context, Redux) con tests
- [x] **Fase 8**: performance (Redis, k6, Lighthouse) con mediciones antes/después (front y backend medidos)
- [x] **Fase 9**: CI/CD con GitHub Actions y publicación de imágenes
- [x] **Panel del dueño** (solo reservas del local)
- [x] **Notificaciones**: bandeja dentro de la app para el cliente (`notifications-service`)
- [x] **ESLint** en todo el monorepo, con reglas de promesas y hooks, y un job en el CI

## Estructura

```
reservas-platform/
├── package.json            # npm workspaces
├── eslint.config.mjs       # una sola configuración de lint para todo el repo
├── docker-compose.yml
├── .env.example
├── e2e/                    # prueba de punta a punta de la saga
├── perf/                   # pruebas de carga con k6, datos de prueba y comparador (Fase 8)
├── observability/          # Loki, Alloy, Grafana
├── .github/
│   ├── workflows/          # ci.yml (pruebas) y release.yml (publica imágenes)
│   └── dependabot.yml
├── apps/
│   └── web/                # frontend (Vite + React + TypeScript + Tailwind)
└── services/
    ├── auth-service/
    ├── restaurants-service/
    ├── reservations-service/
    ├── payments-service/
    ├── notifications-service/
    └── web-bff/
```
