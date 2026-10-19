/**
 * Pruebas de integración contra un PostgreSQL REAL (no mocks).
 *
 * Lo que estas pruebas demuestran y los unitarios no pueden: que la restricción EXCLUDE de la base
 * evita las reservas dobles cuando muchas requests llegan a la vez.
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 * Usan un schema temporal (it_<fecha>_<azar>) que se borra al final: no tocan tus datos.
 * Conexión: TEST_DB_HOST/PORT/USER/PASSWORD/NAME (por defecto localhost:5434, usuario reservations).
 * El usuario necesita permiso para CREATE EXTENSION btree_gist (en el contenedor ya lo tiene).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureApp } from '../app.setup';
import { RestaurantInfo, RestaurantsClient } from '../restaurants-client/restaurants-client.service';
import { Role } from '../security/role.enum';

const RID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_RID = '64b7f0c2a1b2c3d4e5f60719';
const SCHEMA = `it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Abierto todos los días de 10:00 a 23:00. Mesas: 1(2), 2(4), 3(4), 4(8)
const restaurant = (id: string): RestaurantInfo => ({
  id,
  ownerId: 'owner-1',
  name: 'Resto de prueba',
  tables: [
    { number: 1, capacity: 2 },
    { number: 2, capacity: 4 },
    { number: 3, capacity: 4 },
    { number: 4, capacity: 8 },
  ],
  openingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opens: '10:00', closes: '23:00' })),
});

// Una fecha futura (5 días desde hoy). Argentina no tiene horario de verano: -03:00 fijo.
const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${day}T${hhmm}:00-03:00`;

describe('reservations-service (integración con PostgreSQL real)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;

  const bearer = (sub: string, role: Role = Role.CUSTOMER) =>
    `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, name: `Nombre de ${sub}`, role })}`;
  const ownerAuth = () => bearer('owner-1', Role.RESTAURANT_OWNER);

  const book = (customer: string, partySize: number, startsAt: string, restaurantId = RID) =>
    request(app.getHttpServer())
      .post('/reservations')
      .set('Authorization', bearer(customer))
      .send({ restaurantId, partySize, startsAt });

  beforeAll(async () => {
    const env = process.env;
    Object.assign(process.env, {
      JWT_SECRET: 'integration-secret',
      DB_HOST: env.TEST_DB_HOST ?? 'localhost',
      DB_PORT: env.TEST_DB_PORT ?? '5434',
      DB_USER: env.TEST_DB_USER ?? 'reservations',
      DB_PASSWORD: env.TEST_DB_PASSWORD ?? 'reservations_password',
      DB_NAME: env.TEST_DB_NAME ?? 'reservations_db',
      DB_SCHEMA: SCHEMA,
      RESTAURANT_TIME_ZONE: 'America/Argentina/Buenos_Aires',
      NODE_ENV: 'test',
    });

    // TypeORM no crea el schema solo: se crea antes de levantar la app
    const admin = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.destroy();

    // Se importa recién ahora para que ConfigModule vea las variables de arriba
    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RestaurantsClient)
      .useValue({ getRestaurant: async (id: string) => restaurant(id) })
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0); // un solo servidor para todas las requests de supertest
    ds = moduleRef.get(DataSource);
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await app?.close();
  });

  // Cada prueba arranca con la tabla vacía
  beforeEach(async () => {
    await ds.query(`TRUNCATE "${SCHEMA}"."reservations"`);
  });

  it('GET /health responde ok con la base conectada', async () => {
    const res = await request(app.getHttpServer()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('creó la restricción de exclusión en el schema temporal', async () => {
    const rows = await ds.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${SCHEMA}"."reservations"'::regclass AND contype = 'x'`,
    );

    expect(rows).toEqual([{ conname: 'reservations_no_overlap' }]);
  });

  describe('asignación de mesa', () => {
    it('elige la mesa más chica en la que entra el grupo', async () => {
      const two = await book('c1', 2, at('20:00'));
      const three = await book('c2', 3, at('20:00'));
      const seven = await book('c3', 7, at('20:00'));

      expect(two.status).toBe(201);
      expect([two.body.tableNumber, three.body.tableNumber, seven.body.tableNumber]).toEqual([1, 2, 4]);
    });

    it('guarda la reserva con inicio, fin (+90 min), cliente y estado', async () => {
      const res = await book('c1', 3, at('20:00'));

      expect(res.body).toMatchObject({
        restaurantId: RID,
        customerId: 'c1',
        customerName: 'Nombre de c1',
        partySize: 3,
        status: 'CONFIRMED',
        startsAt: new Date(at('20:00')).toISOString(),
      });
      expect(new Date(res.body.endsAt).getTime() - new Date(res.body.startsAt).getTime()).toBe(90 * 60_000);
    });

    it('a medida que se ocupan las mesas aptas, reparte entre ellas y después responde 409', async () => {
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await book(`c${i}`, 3, at('20:00')));

      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 409]);
      expect(results.slice(0, 3).map((r) => r.body.tableNumber)).toEqual([2, 3, 4]);
      expect(results[3].body.message).toMatch(/No hay mesas disponibles/i);
    });
  });

  describe('solapamientos', () => {
    it('una reserva que empieza justo cuando termina otra en la misma mesa es válida', async () => {
      const first = await book('c1', 7, at('20:00')); // solo cabe en la mesa 4: 20:00–21:30
      const next = await book('c2', 7, at('21:30'));

      expect([first.status, next.status]).toEqual([201, 201]);
      expect(next.body.tableNumber).toBe(4);
    });

    it('si se superpone un minuto con otra en la única mesa apta, responde 409', async () => {
      await book('c1', 7, at('20:00'));
      const overlap = await book('c2', 7, at('21:00'));

      expect(overlap.status).toBe(409);
    });

    it('el mismo horario en OTRO restaurante no choca', async () => {
      await book('c1', 7, at('20:00'), RID);
      const other = await book('c2', 7, at('20:00'), OTHER_RID);

      expect(other.status).toBe(201);
    });

    it('la restricción está en la base: un INSERT directo que se solapa es rechazado (23P01)', async () => {
      await book('c1', 7, at('20:00'));
      const [{ starts_at }] = await ds.query(`SELECT starts_at FROM "${SCHEMA}"."reservations"`);

      const insert = (status: string) =>
        ds.query(
          `INSERT INTO "${SCHEMA}"."reservations"
             (restaurant_id, table_number, customer_id, party_size, starts_at, ends_at, status)
           VALUES ($1, 4, 'raw', 5, $2, $2::timestamptz + interval '90 minutes', $3)`,
          [RID, starts_at, status],
        );

      await expect(insert('CONFIRMED')).rejects.toMatchObject({ code: '23P01' });
      // Las que no están CONFIRMED no bloquean la mesa
      await expect(insert('CANCELLED')).resolves.toBeDefined();
      await expect(insert('NO_SHOW')).resolves.toBeDefined();
    });
  });

  describe('concurrencia (lo importante)', () => {
    it('20 personas piden a la vez la ÚNICA mesa apta: gana exactamente una y las otras 19 reciben 409', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => book(`racer-${i}`, 7, at('21:00'))),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(19);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true); // ningún 500

      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM "${SCHEMA}"."reservations"`);
      expect(count).toBe(1);
    });

    it('20 personas piden a la vez un grupo de 3 (3 mesas aptas): se asignan 3 mesas distintas y 17 reciben 409', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => book(`racer-${i}`, 3, at('21:00'))),
      );

      const ok = responses.filter((r) => r.status === 201);
      expect(ok).toHaveLength(3);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(17);
      expect(new Set(ok.map((r) => r.body.tableNumber))).toEqual(new Set([2, 3, 4]));
    });

    it('pedidos simultáneos con horarios que se pisan parcialmente: nunca queda una mesa doblemente reservada', async () => {
      const times = ['20:00', '20:30', '21:00', '21:30', '22:00'];
      await Promise.all(Array.from({ length: 30 }, (_, i) => book(`r-${i}`, 7, at(times[i % times.length]))));

      const overlaps = await ds.query(`
        SELECT count(*)::int AS count
        FROM "${SCHEMA}"."reservations" a
        JOIN "${SCHEMA}"."reservations" b
          ON a.id < b.id AND a.restaurant_id = b.restaurant_id AND a.table_number = b.table_number
         AND a.status = 'CONFIRMED' AND b.status = 'CONFIRMED'
         AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at`);
      expect(overlaps[0].count).toBe(0);
    });
  });

  describe('cancelación y estados', () => {
    it('cancelar libera la mesa para otra persona', async () => {
      const first = await book('c1', 7, at('20:00'));
      expect((await book('c2', 7, at('20:00'))).status).toBe(409);

      const cancel = await request(app.getHttpServer())
        .post(`/reservations/${first.body.id}/cancel`)
        .set('Authorization', bearer('c1'));
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'c1' });

      const retry = await book('c2', 7, at('20:00'));
      expect(retry.status).toBe(201);
      expect(retry.body.tableNumber).toBe(4);
    });

    it('10 cancelaciones simultáneas de la misma reserva: una sola es 200 y el resto 409', async () => {
      const created = await book('c1', 3, at('20:00'));

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app.getHttpServer()).post(`/reservations/${created.body.id}/cancel`).set('Authorization', bearer('c1')),
        ),
      );

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, ...Array(9).fill(409)]);
    });

    it('cancelar dos veces: la segunda es 409', async () => {
      const created = await book('c1', 3, at('20:00'));
      const cancel = () =>
        request(app.getHttpServer()).post(`/reservations/${created.body.id}/cancel`).set('Authorization', bearer('c1'));

      expect((await cancel()).status).toBe(200);
      expect((await cancel()).status).toBe(409);
    });

    it('un tercero no puede ver ni cancelar la reserva (404) y esta sigue confirmada', async () => {
      const created = await book('c1', 3, at('20:00'));

      const view = await request(app.getHttpServer()).get(`/reservations/${created.body.id}`).set('Authorization', bearer('intruso'));
      const cancel = await request(app.getHttpServer()).post(`/reservations/${created.body.id}/cancel`).set('Authorization', bearer('intruso'));
      const stillThere = await request(app.getHttpServer()).get(`/reservations/${created.body.id}`).set('Authorization', bearer('c1'));

      expect([view.status, cancel.status]).toEqual([404, 404]);
      expect(stillThere.body.status).toBe('CONFIRMED');
    });

    it('el dueño del restaurante puede ver y cancelar', async () => {
      const created = await book('c1', 3, at('20:00'));

      const view = await request(app.getHttpServer()).get(`/reservations/${created.body.id}`).set('Authorization', ownerAuth());
      const cancel = await request(app.getHttpServer()).post(`/reservations/${created.body.id}/cancel`).set('Authorization', ownerAuth());

      expect(view.status).toBe(200);
      expect(cancel.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'owner-1' });
    });

    it('el dueño no puede marcar COMPLETED una reserva futura (400)', async () => {
      const created = await book('c1', 3, at('20:00'));

      const res = await request(app.getHttpServer())
        .patch(`/reservations/${created.body.id}/status`)
        .set('Authorization', ownerAuth())
        .send({ status: 'COMPLETED' });

      expect(res.status).toBe(400);
    });

    it('marcar COMPLETED una reserva que ya empezó funciona y libera el rango para la grilla', async () => {
      const created = await book('c1', 3, at('20:00'));
      // Se simula que ya pasó la hora de la reserva
      await ds.query(
        `UPDATE "${SCHEMA}"."reservations" SET starts_at = now() - interval '2 hours', ends_at = now() - interval '30 minutes' WHERE id = $1`,
        [created.body.id],
      );

      const res = await request(app.getHttpServer())
        .patch(`/reservations/${created.body.id}/status`)
        .set('Authorization', ownerAuth())
        .send({ status: 'COMPLETED' });
      const again = await request(app.getHttpServer())
        .patch(`/reservations/${created.body.id}/status`)
        .set('Authorization', ownerAuth())
        .send({ status: 'NO_SHOW' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
      expect(again.status).toBe(409); // ya no se puede volver a cambiar
    });
  });

  describe('listados', () => {
    it('"mine" solo trae las reservas del usuario, paginadas', async () => {
      await book('c1', 2, at('18:00'));
      await book('c1', 2, at('19:30'));
      await book('c1', 2, at('21:00'));
      await book('otro', 2, at('18:00'));

      const res = await request(app.getHttpServer()).get('/reservations/mine?limit=2&page=1').set('Authorization', bearer('c1'));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.every((r: { customerId: string }) => r.customerId === 'c1')).toBe(true);
      // más recientes primero
      expect(res.body.data[0].startsAt > res.body.data[1].startsAt).toBe(true);
    });

    it('el dueño lista las reservas de su restaurante filtrando por día; un cliente recibe 403', async () => {
      await book('c1', 2, at('18:00'));
      await book('c2', 2, at('20:00'));

      const res = await request(app.getHttpServer())
        .get(`/reservations/restaurant/${RID}?date=${day}`)
        .set('Authorization', ownerAuth());
      const wrongDay = await request(app.getHttpServer())
        .get(`/reservations/restaurant/${RID}?date=2030-01-01`)
        .set('Authorization', ownerAuth());
      const asCustomer = await request(app.getHttpServer())
        .get(`/reservations/restaurant/${RID}`)
        .set('Authorization', bearer('c1'));

      expect(res.body.total).toBe(2);
      expect(res.body.data.map((r: { customerId: string }) => r.customerId)).toEqual(['c1', 'c2']); // cronológico
      expect(wrongDay.body.total).toBe(0);
      expect(asCustomer.status).toBe(403);
    });
  });

  describe('resumen del día', () => {
    const summary = (date: string, auth = ownerAuth()) =>
      request(app.getHttpServer()).get(`/reservations/restaurant/${RID}/summary?date=${date}`).set('Authorization', auth);

    it('cuenta las reservas del día por estado, con la consulta agregada en la base real', async () => {
      const first = await book('c1', 2, at('18:00'));
      await book('c2', 2, at('20:00'));
      await book('c3', 4, at('10:00'));
      await request(app.getHttpServer()).post(`/reservations/${first.body.id}/cancel`).set('Authorization', bearer('c1'));

      const res = await summary(day);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        date: day,
        total: 3,
        byStatus: { PENDING_PAYMENT: 0, CONFIRMED: 2, CANCELLED: 1, EXPIRED: 0, COMPLETED: 0, NO_SHOW: 0 },
      });
    });

    it('un día sin reservas da todo en 0 y otro día no se mezcla', async () => {
      await book('c1', 2, at('18:00'));

      const empty = await summary('2030-01-01');
      const other = await summary(new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10));

      expect(empty.body.total).toBe(0);
      expect(other.body.total).toBe(0);
    });

    it('un cliente (403) y un dueño ajeno (404) no ven el resumen', async () => {
      await book('c1', 2, at('18:00'));

      expect((await summary(day, bearer('c1'))).status).toBe(403);
      expect((await summary(day, bearer('owner-ajeno', Role.RESTAURANT_OWNER))).status).toBe(404);
    });
  });

  describe('disponibilidad', () => {
    const availability = (partySize: number) =>
      request(app.getHttpServer()).get('/availability').query({ restaurantId: RID, date: day, partySize });

    it('sin reservas ofrece toda la grilla del día', async () => {
      const res = await availability(7);

      expect(res.status).toBe(200);
      // 10:00–23:00 con reservas de 90 min cada 30 → de 10:00 a 21:30 = 24 horarios
      expect(res.body.slots).toHaveLength(24);
      expect(res.body.slots[0].availableTables).toBe(1);
    });

    it('refleja las reservas: los horarios que se solapan con la única mesa apta desaparecen', async () => {
      await book('c1', 7, at('20:00')); // mesa 4 ocupada 20:00–21:30

      const res = await availability(7);
      const starts: string[] = res.body.slots.map((s: { startsAt: string }) => s.startsAt);
      const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

      for (const hhmm of ['18:30', '21:30']) expect(starts).toContain(iso(hhmm)); // pegados: libres
      for (const hhmm of ['19:00', '19:30', '20:00', '20:30', '21:00']) expect(starts).not.toContain(iso(hhmm));
    });

    it('un grupo chico sigue viendo disponibilidad porque hay otras mesas', async () => {
      await book('c1', 7, at('20:00'));

      const res = await availability(2);
      const slot = res.body.slots.find((s: { startsAt: string }) => s.startsAt === new Date(at('20:00')).toISOString());

      expect(slot.availableTables).toBe(3); // mesas 1, 2 y 3 (la 4 está ocupada)
    });

    it('una reserva cancelada vuelve a aparecer como disponible', async () => {
      const created = await book('c1', 7, at('20:00'));
      await request(app.getHttpServer()).post(`/reservations/${created.body.id}/cancel`).set('Authorization', bearer('c1'));

      const res = await availability(7);

      expect(res.body.slots).toHaveLength(24);
    });

    it('lo que dice la disponibilidad coincide con lo que acepta la reserva', async () => {
      await book('c1', 7, at('20:00'));
      const res = await availability(7);
      const offered = new Set(res.body.slots.map((s: { startsAt: string }) => s.startsAt));

      for (const hhmm of ['19:00', '19:30', '20:00', '20:30', '21:00', '21:30']) {
        const booking = await book(`probe-${hhmm}`, 7, at(hhmm));
        const wasOffered = offered.has(new Date(at(hhmm)).toISOString());
        expect({ hhmm, status: booking.status }).toEqual({ hhmm, status: wasOffered ? 201 : 409 });
        if (booking.status === 201) {
          await request(app.getHttpServer())
            .post(`/reservations/${booking.body.id}/cancel`)
            .set('Authorization', bearer(`probe-${hhmm}`));
        }
      }
    });
  });
});
