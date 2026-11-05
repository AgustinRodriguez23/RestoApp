/**
 * Solicitudes para ser dueño contra un PostgreSQL REAL (no mocks), con la app entera y tokens de verdad.
 *
 * Lo que estas pruebas demuestran y los unitarios no pueden: que la base frena los envíos dobles (índice único
 * parcial) y las revisiones simultáneas (UPDATE condicional), y que aprobar cambia el rol en la misma transacción.
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 * Usan un schema temporal (it_req_<fecha>_<azar>) que se borra al final: no tocan tus datos.
 * Conexión: TEST_DB_HOST/PORT/USER/PASSWORD/NAME (por defecto localhost:5433, usuario auth).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { configureApp } from '../app.setup';

const SCHEMA = `it_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const solicitud = {
  restaurantName: 'La Esquina de Ana',
  address: 'Av. Corrientes 1234, CABA',
  phone: '+54 11 5555-1234',
  message: 'Tenemos 12 mesas.',
};

describe('solicitudes para ser dueño (integración con PostgreSQL real)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwt: JwtService;
  let adminToken: string;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Un cliente nuevo por prueba, registrado por la API: el token es el que daría la app. */
  async function customer(): Promise<{ id: string; token: string }> {
    const res = await http()
      .post('/auth/register')
      .send({ email: `cliente-${++counter}@example.com`, name: `Cliente ${counter}`, password: 'Password123' });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, token: res.body.accessToken };
  }

  const send = (token: string) => http().post('/owner-requests').set(auth(token)).send(solicitud);
  const approve = (id: string) => http().post(`/owner-requests/${id}/approve`).set(auth(adminToken));
  const reject = (id: string) =>
    http().post(`/owner-requests/${id}/reject`).set(auth(adminToken)).send({ reason: 'No pudimos verificar el local.' });
  const roleOf = async (userId: string) =>
    ((await ds.query(`SELECT role FROM "${SCHEMA}".users WHERE id = $1`, [userId])) as { role: string }[])[0].role;
  /** Los avisos que quedaron en el outbox para una solicitud (sin RabbitMQ en estas pruebas, nadie los publica). */
  const eventsOf = async (requestId: string) =>
    (await ds.query(`SELECT type, payload FROM "${SCHEMA}".outbox_messages WHERE payload->'data'->>'requestId' = $1`, [
      requestId,
    ])) as { type: string; payload: { data: Record<string, unknown> } }[];

  beforeAll(async () => {
    const env = process.env;
    Object.assign(process.env, {
      JWT_SECRET: 'integration-secret',
      JWT_EXPIRES_IN: '1h',
      DB_HOST: env.TEST_DB_HOST ?? 'localhost',
      DB_PORT: env.TEST_DB_PORT ?? '5433',
      DB_USER: env.TEST_DB_USER ?? 'auth',
      DB_PASSWORD: env.TEST_DB_PASSWORD ?? 'auth_password',
      DB_NAME: env.TEST_DB_NAME ?? 'auth_db',
      DB_SCHEMA: SCHEMA,
      // Vacía y no ausente: si no, se leería la del .env de la raíz y el relay publicaría (y marcaría) los eventos
      RABBITMQ_URL: '',
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0); // un solo servidor para todas las requests de supertest
    ds = moduleRef.get(DataSource);
    jwt = moduleRef.get(JwtService);

    // El admin se crea como en producción: un usuario común al que se le cambia el rol en la base
    const { id } = await customer();
    await ds.query(`UPDATE "${SCHEMA}".users SET role = 'ADMIN' WHERE id = $1`, [id]);
    const login = await http().post('/auth/login').send({ email: `cliente-${counter}@example.com`, password: 'Password123' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await app?.close();
  });

  it('nadie puede registrarse como admin', async () => {
    const res = await http()
      .post('/auth/register')
      .send({ email: 'colado@example.com', name: 'Colado', password: 'Password123', role: 'ADMIN' });

    expect(res.status).toBe(400);
  });

  it('un cliente envía la solicitud y la ve pendiente', async () => {
    const ana = await customer();

    const created = await send(ana.token);
    const mine = await http().get('/owner-requests/mine').set(auth(ana.token));

    expect(created.status).toBe(201);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id: created.body.id, status: 'PENDING', restaurantName: solicitud.restaurantName });
  });

  it('sin solicitud, /mine responde 404', async () => {
    const ana = await customer();

    expect((await http().get('/owner-requests/mine').set(auth(ana.token))).status).toBe(404);
  });

  it('dos envíos a la vez (doble click): la base deja pasar uno solo', async () => {
    const ana = await customer();

    const responses = await Promise.all(Array.from({ length: 5 }, () => send(ana.token)));

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const rows = await ds.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".owner_requests WHERE user_id = $1`, [ana.id]);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('aprobar convierte al usuario en dueño, y el token renovado ya lo dice sin alargar la sesión', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);

    const res = await approve(body.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(await roleOf(ana.id)).toBe('RESTAURANT_OWNER');

    const renewed = await http().post('/auth/token').set(auth(ana.token));
    expect(renewed.status).toBe(200);
    expect(renewed.body.user.role).toBe('RESTAURANT_OWNER');
    const before = jwt.decode<{ exp: number }>(ana.token);
    const after = jwt.decode<{ exp: number; role: string }>(renewed.body.accessToken);
    expect(after.role).toBe('RESTAURANT_OWNER');
    expect(after.exp).toBe(before.exp);
  });

  it('aprobar deja el aviso en el outbox, con lo necesario para armarlo', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);

    await approve(body.id);

    const events = await eventsOf(body.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('owner-request.approved');
    expect(events[0].payload.data).toEqual({ requestId: body.id, userId: ana.id, restaurantName: solicitud.restaurantName });
  });

  it('con el token viejo (todavía dice CUSTOMER), un dueño recién aprobado no puede volver a pedir', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);
    await approve(body.id);

    expect((await send(ana.token)).status).toBe(403);
  });

  it('aprobar y rechazar a la vez: gana uno solo y el rol queda coherente con el estado', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);

    const [a, r] = await Promise.all([approve(body.id), reject(body.id)]);

    expect([a.status, r.status].sort()).toEqual([200, 409]);
    const [row] = (await ds.query(`SELECT status FROM "${SCHEMA}".owner_requests WHERE id = $1`, [body.id])) as {
      status: string;
    }[];
    expect(await roleOf(ana.id)).toBe(row.status === 'APPROVED' ? 'RESTAURANT_OWNER' : 'CUSTOMER');
    // Y un solo aviso, el del que ganó: el que perdió se deshizo con su transacción
    expect((await eventsOf(body.id)).map((event) => event.type)).toEqual([
      row.status === 'APPROVED' ? 'owner-request.approved' : 'owner-request.rejected',
    ]);
  });

  it('si el usuario dejó de ser cliente, aprobar se deshace entero: la solicitud sigue pendiente', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);
    await ds.query(`UPDATE "${SCHEMA}".users SET role = 'ADMIN' WHERE id = $1`, [ana.id]);

    expect((await approve(body.id)).status).toBe(409);
    const [row] = (await ds.query(`SELECT status, reviewed_by FROM "${SCHEMA}".owner_requests WHERE id = $1`, [
      body.id,
    ])) as { status: string; reviewed_by: string | null }[];
    expect(row).toEqual({ status: 'PENDING', reviewed_by: null });
    expect(await eventsOf(body.id)).toEqual([]); // no se avisa de algo que no pasó
  });

  it('rechazada, el usuario ve el motivo y puede volver a enviar', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);

    expect((await reject(body.id)).status).toBe(200);
    const mine = await http().get('/owner-requests/mine').set(auth(ana.token));
    expect(mine.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'No pudimos verificar el local.' });
    expect(await roleOf(ana.id)).toBe('CUSTOMER');
    const [event] = await eventsOf(body.id);
    expect(event.type).toBe('owner-request.rejected');
    expect(event.payload.data).toMatchObject({ userId: ana.id, reason: 'No pudimos verificar el local.' });

    expect((await send(ana.token)).status).toBe(201);
  });

  it('el admin lista las pendientes con los datos de quien las envió; un cliente no puede', async () => {
    const ana = await customer();
    await send(ana.token);

    const list = await http().get('/owner-requests').set(auth(adminToken));
    const asCustomer = await http().get('/owner-requests').set(auth(ana.token));

    expect(list.status).toBe(200);
    expect(list.body.data.every((item: { status: string }) => item.status === 'PENDING')).toBe(true);
    expect(list.body.data).toContainEqual(
      expect.objectContaining({ applicant: expect.objectContaining({ id: ana.id, email: `cliente-${counter}@example.com` }) }),
    );
    expect(asCustomer.status).toBe(403);
  });

  it('una solicitud que no existe da 404, y una ya revisada da 409', async () => {
    const ana = await customer();
    const { body } = await send(ana.token);
    await reject(body.id);

    expect((await approve('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await approve(body.id)).status).toBe(409);
  });
});
