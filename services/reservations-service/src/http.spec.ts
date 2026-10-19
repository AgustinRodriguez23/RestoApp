import { ConflictException, INestApplication, NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { AvailabilityController } from './reservations/availability.controller';
import { AvailabilityService } from './reservations/availability.service';
import { ReservationsController } from './reservations/reservations.controller';
import { ReservationsService } from './reservations/reservations.service';
import { Role } from './security/role.enum';
import { SecurityModule } from './security/security.module';

const RID = '64b7f0c2a1b2c3d4e5f60718';
const RES_ID = '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10';

const validBody = { restaurantId: RID, partySize: 3, startsAt: '2026-10-16T21:00:00-03:00' };

describe('HTTP (controllers + guards + validación + filtro de errores)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let reservations: Record<'create' | 'findOne' | 'cancel' | 'updateStatus' | 'listMine' | 'listForRestaurant' | 'summaryForRestaurant', jest.Mock>;
  let availability: { getAvailability: jest.Mock };

  const token = (role: Role, sub = 'user-1') => jwt.sign({ sub, email: `${sub}@example.com`, role });
  const bearer = (role: Role, sub?: string) => `Bearer ${token(role, sub)}`;

  beforeAll(async () => {
    reservations = {
      create: jest.fn(),
      findOne: jest.fn(),
      cancel: jest.fn(),
      updateStatus: jest.fn(),
      listMine: jest.fn(),
      listForRestaurant: jest.fn(),
      summaryForRestaurant: jest.fn(),
    };
    availability = { getAvailability: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: 'test-secret' })] }),
        SecurityModule,
      ],
      controllers: [ReservationsController, AvailabilityController],
      providers: [
        { provide: ReservationsService, useValue: reservations },
        { provide: AvailabilityService, useValue: availability },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  describe('autenticación', () => {
    it.each([
      ['POST', '/reservations'],
      ['GET', '/reservations/mine'],
      ['GET', `/reservations/restaurant/${RID}`],
      ['GET', `/reservations/restaurant/${RID}/summary?date=2026-10-16`],
      ['GET', `/reservations/${RES_ID}`],
      ['POST', `/reservations/${RES_ID}/cancel`],
      ['PATCH', `/reservations/${RES_ID}/status`],
    ])('%s %s sin token responde 401', async (method, url) => {
      const res = await request(app.getHttpServer())[method.toLowerCase() as 'get'](url);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401, path: url });
    });

    it('un token inválido responde 401', async () => {
      const res = await request(app.getHttpServer()).get('/reservations/mine').set('Authorization', 'Bearer basura');

      expect(res.status).toBe(401);
    });

    it('un token firmado con otro secreto responde 401', async () => {
      const forged = new JwtService({ secret: 'otro-secreto' }).sign({ sub: 'x', email: 'x@x.com', role: Role.CUSTOMER });

      const res = await request(app.getHttpServer()).get('/reservations/mine').set('Authorization', `Bearer ${forged}`);

      expect(res.status).toBe(401);
      expect(reservations.listMine).not.toHaveBeenCalled();
    });

    it('un token vencido responde 401', async () => {
      const expired = jwt.sign({ sub: 'x', email: 'x@x.com', role: Role.CUSTOMER }, { expiresIn: -10 });

      const res = await request(app.getHttpServer()).get('/reservations/mine').set('Authorization', `Bearer ${expired}`);

      expect(res.status).toBe(401);
    });

    it('la disponibilidad es pública: no pide token', async () => {
      availability.getAvailability.mockResolvedValue({ slots: [] });

      const res = await request(app.getHttpServer()).get('/availability').query({ restaurantId: RID, date: '2026-10-16', partySize: 3 });

      expect(res.status).toBe(200);
    });
  });

  describe('roles', () => {
    it('un cliente no puede listar las reservas de un restaurante (403)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/reservations/restaurant/${RID}`)
        .set('Authorization', bearer(Role.CUSTOMER));

      expect(res.status).toBe(403);
      expect(reservations.listForRestaurant).not.toHaveBeenCalled();
    });

    it('un cliente no puede marcar una reserva como completada (403)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/reservations/${RES_ID}/status`)
        .set('Authorization', bearer(Role.CUSTOMER))
        .send({ status: 'COMPLETED' });

      expect(res.status).toBe(403);
      expect(reservations.updateStatus).not.toHaveBeenCalled();
    });

    it('el dueño sí puede listar las reservas de su restaurante, con el usuario del token', async () => {
      reservations.listForRestaurant.mockResolvedValue({ data: [], page: 1, limit: 20, total: 0, totalPages: 0 });

      const res = await request(app.getHttpServer())
        .get(`/reservations/restaurant/${RID}`)
        .query({ date: '2026-10-16' })
        .set('Authorization', bearer(Role.RESTAURANT_OWNER, 'owner-1'));

      expect(res.status).toBe(200);
      const [restaurantId, user, query] = reservations.listForRestaurant.mock.calls[0];
      expect(restaurantId).toBe(RID);
      expect(user).toMatchObject({ sub: 'owner-1', role: Role.RESTAURANT_OWNER });
      expect(query).toMatchObject({ date: '2026-10-16' });
    });

    it('el dueño marca una reserva como NO_SHOW', async () => {
      reservations.updateStatus.mockResolvedValue({ id: RES_ID, status: 'NO_SHOW' });

      const res = await request(app.getHttpServer())
        .patch(`/reservations/${RES_ID}/status`)
        .set('Authorization', bearer(Role.RESTAURANT_OWNER, 'owner-1'))
        .send({ status: 'NO_SHOW' });

      expect(res.status).toBe(200);
      expect(reservations.updateStatus).toHaveBeenCalledWith(RES_ID, expect.objectContaining({ sub: 'owner-1' }), 'NO_SHOW');
    });

    it('no se puede fijar CANCELLED por este endpoint (cancelar tiene el suyo)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/reservations/${RES_ID}/status`)
        .set('Authorization', bearer(Role.RESTAURANT_OWNER))
        .send({ status: 'CANCELLED' });

      expect(res.status).toBe(400);
      expect(reservations.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('POST /reservations', () => {
    it('crea la reserva usando al usuario del token y responde 201', async () => {
      reservations.create.mockResolvedValue({ id: RES_ID, status: 'CONFIRMED' });

      const res = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', bearer(Role.CUSTOMER, 'cust-9'))
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: RES_ID, status: 'CONFIRMED' });
      expect(reservations.create).toHaveBeenCalledWith(expect.objectContaining({ sub: 'cust-9' }), validBody);
    });

    it('ignora/rechaza intentar elegir otro cliente (mass assignment)', async () => {
      const res = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', bearer(Role.CUSTOMER))
        .send({ ...validBody, customerId: 'otro', status: 'COMPLETED', tableNumber: 1 });

      expect(res.status).toBe(400);
      expect(reservations.create).not.toHaveBeenCalled();
    });

    it.each([
      ['restaurantId mal formado', { restaurantId: '123' }],
      ['partySize 0', { partySize: 0 }],
      ['partySize decimal', { partySize: 2.5 }],
      ['partySize como texto', { partySize: '3' }],
      ['partySize mayor a 50', { partySize: 51 }],
      ['startsAt sin zona horaria', { startsAt: '2026-10-16T21:00:00' }],
      ['startsAt que no es fecha', { startsAt: 'mañana a la noche' }],
      ['notes demasiado largas', { notes: 'x'.repeat(301) }],
    ])('rechaza %s con 400', async (_label, override) => {
      const res = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', bearer(Role.CUSTOMER))
        .send({ ...validBody, ...override });

      expect(res.status).toBe(400);
      expect(reservations.create).not.toHaveBeenCalled();
    });

    it('respeta el formato de error común', async () => {
      const res = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', bearer(Role.CUSTOMER))
        .send({});

      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.any(Array),
        path: '/reservations',
        timestamp: expect.any(String),
      });
    });

    it('un 409 del servicio llega como 409 con el mensaje', async () => {
      reservations.create.mockRejectedValue(new ConflictException('No quedan mesas libres'));

      const res = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', bearer(Role.CUSTOMER))
        .send(validBody);

      expect(res.status).toBe(409);
      expect(res.body.message).toBe('No quedan mesas libres');
    });

    it('un error inesperado es un 500 que no filtra detalles', async () => {
      reservations.create.mockRejectedValue(new Error('password authentication failed for user "reservations"'));

      const res = await request(app.getHttpServer())
        .post('/reservations')
        .set('Authorization', bearer(Role.CUSTOMER))
        .send(validBody);

      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('password');
    });
  });

  describe('rutas con :id', () => {
    it('"mine" no se confunde con un id', async () => {
      reservations.listMine.mockResolvedValue({ data: [], page: 1, limit: 20, total: 0, totalPages: 0 });

      const res = await request(app.getHttpServer()).get('/reservations/mine').set('Authorization', bearer(Role.CUSTOMER));

      expect(res.status).toBe(200);
      expect(reservations.findOne).not.toHaveBeenCalled();
    });

    it('un id que no es UUID responde 400 sin llegar a la base', async () => {
      const res = await request(app.getHttpServer()).get('/reservations/123').set('Authorization', bearer(Role.CUSTOMER));

      expect(res.status).toBe(400);
      expect(reservations.findOne).not.toHaveBeenCalled();
    });

    describe('GET /reservations/restaurant/:id/summary', () => {
      const summary = (token: string, query: Record<string, string> = { date: '2026-10-16' }, id = RID) =>
        request(app.getHttpServer()).get(`/reservations/restaurant/${id}/summary`).query(query).set('Authorization', token);

      it('un cliente recibe 403 y no se consulta nada', async () => {
        expect((await summary(bearer(Role.CUSTOMER))).status).toBe(403);
        expect(reservations.summaryForRestaurant).not.toHaveBeenCalled();
      });

      it('el dueño recibe el resumen, y el servicio recibe su usuario, el restaurante y el día', async () => {
        const body = { date: '2026-10-16', total: 3, byStatus: { CONFIRMED: 3 } };
        reservations.summaryForRestaurant.mockResolvedValue(body);

        const res = await summary(bearer(Role.RESTAURANT_OWNER, 'owner-1'));

        expect(res.status).toBe(200);
        expect(res.body).toEqual(body);
        expect(reservations.summaryForRestaurant).toHaveBeenCalledWith(RID, expect.objectContaining({ sub: 'owner-1' }), '2026-10-16');
      });

      it('la fecha es obligatoria y con formato YYYY-MM-DD (400)', async () => {
        const token = bearer(Role.RESTAURANT_OWNER);
        expect((await summary(token, {})).status).toBe(400);
        expect((await summary(token, { date: '16/10/2026' })).status).toBe(400);
        expect((await summary(token, { date: '2026-10-16' }, 'no-es-un-id')).status).toBe(400);
        expect(reservations.summaryForRestaurant).not.toHaveBeenCalled();
      });

      it('no se confunde con GET /reservations/:id', async () => {
        reservations.summaryForRestaurant.mockResolvedValue({ date: '2026-10-16', total: 0, byStatus: {} });
        await summary(bearer(Role.RESTAURANT_OWNER));
        expect(reservations.findOne).not.toHaveBeenCalled();
      });
    });

    it('un restaurantId inválido en la ruta responde 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/reservations/restaurant/no-es-un-id')
        .set('Authorization', bearer(Role.RESTAURANT_OWNER));

      expect(res.status).toBe(400);
    });

    it('GET /reservations/:id devuelve la reserva', async () => {
      reservations.findOne.mockResolvedValue({ id: RES_ID });

      const res = await request(app.getHttpServer())
        .get(`/reservations/${RES_ID}`)
        .set('Authorization', bearer(Role.CUSTOMER, 'cust-1'));

      expect(res.status).toBe(200);
      expect(reservations.findOne).toHaveBeenCalledWith(RES_ID, expect.objectContaining({ sub: 'cust-1' }));
    });

    it('un 404 del servicio llega como 404', async () => {
      reservations.findOne.mockRejectedValue(new NotFoundException('Reserva no encontrada'));

      const res = await request(app.getHttpServer()).get(`/reservations/${RES_ID}`).set('Authorization', bearer(Role.CUSTOMER));

      expect(res.status).toBe(404);
    });

    it('cancelar responde 200 (no 201)', async () => {
      reservations.cancel.mockResolvedValue({ id: RES_ID, status: 'CANCELLED' });

      const res = await request(app.getHttpServer())
        .post(`/reservations/${RES_ID}/cancel`)
        .set('Authorization', bearer(Role.CUSTOMER, 'cust-1'));

      expect(res.status).toBe(200);
      expect(reservations.cancel).toHaveBeenCalledWith(RES_ID, expect.objectContaining({ sub: 'cust-1' }));
    });
  });

  describe('listados', () => {
    it('convierte page y limit a número y los pasa al servicio', async () => {
      reservations.listMine.mockResolvedValue({ data: [], page: 2, limit: 5, total: 0, totalPages: 0 });

      await request(app.getHttpServer())
        .get('/reservations/mine?page=2&limit=5&status=CONFIRMED')
        .set('Authorization', bearer(Role.CUSTOMER));

      expect(reservations.listMine.mock.calls[0][1]).toEqual({ page: 2, limit: 5, status: 'CONFIRMED' });
    });

    it.each(['page=0', 'limit=1000', 'limit=-1', 'page=abc', 'status=INVENTADO'])('rechaza ?%s con 400', async (qs) => {
      const res = await request(app.getHttpServer()).get(`/reservations/mine?${qs}`).set('Authorization', bearer(Role.CUSTOMER));

      expect(res.status).toBe(400);
    });
  });

  describe('GET /availability', () => {
    it('convierte partySize a número y llama al servicio', async () => {
      availability.getAvailability.mockResolvedValue({ slots: [] });

      await request(app.getHttpServer()).get('/availability').query({ restaurantId: RID, date: '2026-10-16', partySize: '4' });

      expect(availability.getAvailability).toHaveBeenCalledWith({ restaurantId: RID, date: '2026-10-16', partySize: 4 });
    });

    it.each([
      ['sin parámetros', {}],
      ['fecha con otro formato', { restaurantId: RID, date: '16/10/2026', partySize: 2 }],
      ['partySize 0', { restaurantId: RID, date: '2026-10-16', partySize: 0 }],
      ['restaurantId inválido', { restaurantId: 'x', date: '2026-10-16', partySize: 2 }],
    ])('rechaza %s con 400', async (_label, qs) => {
      const res = await request(app.getHttpServer()).get('/availability').query(qs);

      expect(res.status).toBe(400);
      expect(availability.getAvailability).not.toHaveBeenCalled();
    });
  });

  describe('Swagger', () => {
    it('documenta todas las rutas con seguridad Bearer', async () => {
      const config = new DocumentBuilder().setTitle('t').addBearerAuth().build();
      const doc = SwaggerModule.createDocument(app, config);

      expect(Object.keys(doc.paths).sort()).toEqual(
        [
          '/availability',
          '/reservations',
          '/reservations/mine',
          '/reservations/restaurant/{restaurantId}',
          '/reservations/restaurant/{restaurantId}/summary',
          '/reservations/{id}',
          '/reservations/{id}/cancel',
          '/reservations/{id}/status',
        ].sort(),
      );
      expect(doc.paths['/reservations']?.post?.security).toEqual([{ bearer: [] }]);
      expect(doc.paths['/availability']?.get?.security).toBeUndefined();
    });
  });
});
