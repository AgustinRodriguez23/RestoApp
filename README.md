# Reservas Platform

Plataforma de **reservas de restaurantes** (con seña, carta y cobro) construida como **arquitectura de microservicios**. Es un proyecto de práctica pensado para demostrar patrones reales: BFF, comunicación asíncrona con eventos, trazabilidad de logs, tests, Docker y CI/CD.

> Estado: **Fase 9 completa** (CI/CD con GitHub Actions: tests, integración, punta a punta con Docker y publicación de imágenes). Falta la Fase 8 (performance) y los pendientes de la hoja de ruta.

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
| `reservations-service` | Reservas, disponibilidad, estados, seña y vencimiento | PostgreSQL | 3003 | ✅ Fase 3 y 6 |
| `payments-service` | Seña y cobro, idempotencia, webhooks, reembolsos | PostgreSQL | 3004 | ✅ Fase 6 |
| `notifications-service` | Consume eventos y notifica | MongoDB | — | Pendiente |
| `web-bff` | Entrada única del frontend, agrega datos | — | 3000 | ✅ Fase 4 |
| `web` (`apps/web`) | Frontend React: buscar, reservar, pagar la seña | — | 5173 | ✅ Fase 7 |

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
| RabbitMQ (panel) | http://localhost:15672 (usuario `reservas`, clave `reservas_password`) | — | — |
| **web-bff** | http://localhost:3000 | http://localhost:3000/docs | http://localhost:3000/health |
| **web (frontend)** | http://localhost:5173 | — | — |

### Probar el flujo completo

1. En el Swagger de **auth**, registrá un usuario con `"role": "RESTAURANT_OWNER"` y copiá el `accessToken`.
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
- **Pasarela detrás de una interfaz (`PaymentGateway`)**: `createCharge`, `parseWebhook` (verifica firma) y `refund`. Hoy hay una **pasarela simulada** con tokens de prueba y webhooks reales firmados. Para sumar **Mercado Pago** (o Stripe): escribir un `MercadoPagoGateway implements PaymentGateway`, agregar su rama en `gateway/gateway.module.ts` y poner `PAYMENT_PROVIDER=mercadopago` con sus credenciales. El resto del servicio no cambia. (Los tokens `tok_*` se reemplazan por el token que genera el SDK del navegador.)
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

### Limitaciones conocidas

- **Falta el panel del dueño del restaurante** (cargar restaurantes, carta, ver reservas del día): por ahora se hace desde el Swagger.
- El **token se guarda en `localStorage`**: sobrevive al F5 pero un script malicioso (XSS) podría leerlo. Lo más seguro sería que el BFF lo entregue en una cookie `httpOnly`.
- Los **tests** cubren la lógica y las pantallas con un servidor falso (`fetch` simulado); no hay todavía pruebas con un navegador real contra el stack (lo recorrí a mano con Playwright, pero ese script no está en el repo).
- Sin Docker en mi entorno de desarrollo no pude probar la imagen `web` ni la configuración de nginx; sí probé el build de la imagen paso a paso (instalación aislada + `npm run build`) y el frontend contra los servicios reales con `npm run dev`.
- Solo tema claro; sin traducciones (todo en español rioplatense).

## Fase 9: CI/CD (GitHub Actions)

Todo vive en `.github/` y **tiene que estar en la raíz del repositorio** (el repo es la carpeta `reservas-platform`).

### `ci.yml`: se corre en cada pull request y en cada push a una rama que no sea `main`

| Job | Qué verifica | Detalle |
|---|---|---|
| **Unitarios** (×6) | Compila (con chequeo de tipos) y corre los tests de `auth`, `restaurants`, `reservations`, `payments`, `web-bff` y `web` | Un job por paquete, en paralelo y con `fail-fast: false`: si uno falla se ve igual el estado de los demás. Usa `npm ci`, que instala exactamente lo del `package-lock.json` |
| **Integración** (×2) | `reservations` y `payments` contra **PostgreSQL 16 y RabbitMQ reales** | Los lanza como *service containers* con los puertos y credenciales que esperan los tests |
| **Imagen** (×6) | Que cada `Dockerfile` construya | Con caché de capas: si las dependencias no cambiaron no se reinstalan |
| **Punta a punta** | Levanta **todo** con `docker compose` (bases, RabbitMQ, 5 servicios y el front) y corre la saga de la seña a través del BFF | Es lo único que prueba la red entre contenedores y el proxy de nginx. Si falla, sube los logs de todos los contenedores |
| **Auditoría** | `npm audit` de las dependencias de producción | Avisa pero no bloquea (`continue-on-error`): un aviso nuevo en una librería no debería frenar un cambio que no la toca |

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

- **No pude correr los workflows en GitHub** (no tengo acceso desde mi entorno). Lo que sí hice: validarlos con *actionlint* (sin errores; detecta, por ejemplo, un `needs:` que apunta a un job inexistente), y correr en una copia limpia, con `npm ci`, exactamente los mismos comandos que ejecuta cada job: build y tests de los 6 paquetes y la integración de reservations y payments, con las mismas variables que usa el CI. **No corrí el job punta a punta ni las construcciones de imágenes dentro de GitHub**: es probable que la primera corrida necesite algún ajuste; si falla, el log del job dice dónde.
- Las versiones de las acciones (`actions/checkout@v4`, `docker/build-push-action@v6`...) son las que conocía; Dependabot las mantiene al día.
- **No hay etapa de deploy**: se publican imágenes, pero no se despliegan a ningún servidor (todavía no hay un destino definido).
- **No hay lint** en el pipeline porque los paquetes no tienen ESLint configurado todavía.
- Los Dockerfile usan `npm install` (no `npm ci`), así que las imágenes no usan el lockfile; el CI sí lo usa para las pruebas. Pasarlos a `npm ci` requiere construir desde la raíz del monorepo.

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
- [ ] **Fase 8**: performance (Redis, k6, Lighthouse) con mediciones antes/después
- [x] **Fase 9**: CI/CD con GitHub Actions y publicación de imágenes

## Estructura

```
reservas-platform/
├── package.json            # npm workspaces
├── docker-compose.yml
├── .env.example
├── e2e/                    # prueba de punta a punta de la saga
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
    └── web-bff/
```
