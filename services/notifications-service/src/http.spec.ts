import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { SecurityModule } from './security/security.module';

/**
 * Capa HTTP: rutas, validación de la query, JWT y formato de errores. El servicio está simulado (no hay base de datos):
 * lo que se prueba es el cableado, y sobre todo que SIEMPRE se use el usuario del token y nunca uno que mande el cliente.
 */
describe('API HTTP de notifications-service', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const service = { list: jest.fn(), unreadCount: jest.fn(), markRead: jest.fn(), markAllRead: jest.fn() };
  const ID = '64b7f0c2a1b2c3d4e5f60718';

  const token = (sub = 'cust-1') => jwt.sign({ sub, email: `${sub}@example.com`, role: 'CUSTOMER' });
  const bearer = (sub?: string) => ({ Authorization: `Bearer ${token(sub)}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_SECRET: 'secreto-solo-para-tests' })] }),
        SecurityModule,
      ],
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(() => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    service.list.mockResolvedValue({ data: [], page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0 });
    service.unreadCount.mockResolvedValue(0);
    service.markAllRead.mockResolvedValue({ updated: 0 });
    service.markRead.mockResolvedValue({ id: ID, read: true });
  });

  describe('autenticación', () => {
    it.each([
      ['GET', '/notifications'],
      ['GET', '/notifications/unread-count'],
      ['POST', '/notifications/read-all'],
      ['PATCH', `/notifications/${ID}/read`],
    ])('%s %s sin token responde 401', async (method, path) => {
      const res = await request(app.getHttpServer())[method.toLowerCase() as 'get'](path);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/token/i);
      expect(service.list).not.toHaveBeenCalled();
      expect(service.markRead).not.toHaveBeenCalled();
    });

    it('un token inválido responde 401', async () => {
      const res = await request(app.getHttpServer()).get('/notifications').set('Authorization', 'Bearer cualquier-cosa');
      expect(res.status).toBe(401);
    });

    it('un token firmado con otro secreto responde 401', async () => {
      const forged = new JwtService({ secret: 'otro-secreto' }).sign({ sub: 'cust-1', email: 'x@y.com', role: 'CUSTOMER' });
      const res = await request(app.getHttpServer()).get('/notifications').set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /notifications', () => {
    it('usa el usuario del token y los valores por defecto', async () => {
      const res = await request(app.getHttpServer()).get('/notifications').set(bearer('cust-7'));
      expect(res.status).toBe(200);
      expect(service.list).toHaveBeenCalledWith('cust-7', expect.objectContaining({ page: 1, limit: 20 }));
    });

    it('convierte la query: page y limit a número, unread=true a booleano', async () => {
      await request(app.getHttpServer()).get('/notifications?page=2&limit=5&unread=true').set(bearer());
      expect(service.list).toHaveBeenCalledWith('cust-1', { page: 2, limit: 5, unread: true });
    });

    it('unread=false queda en false (no se confunde con "texto no vacío")', async () => {
      await request(app.getHttpServer()).get('/notifications?unread=false').set(bearer());
      expect(service.list).toHaveBeenCalledWith('cust-1', expect.objectContaining({ unread: false }));
    });

    it.each(['page=0', 'page=abc', 'limit=0', 'limit=51', 'limit=1.5', 'unread=quizas', 'unread=1'])(
      'rechaza con 400 la query inválida (%s)',
      async (query) => {
        const res = await request(app.getHttpServer()).get(`/notifications?${query}`).set(bearer());
        expect(res.status).toBe(400);
        expect(service.list).not.toHaveBeenCalled();
      },
    );

    it('rechaza con 400 parámetros que no existen (forbidNonWhitelisted); un userId en la query no se acepta', async () => {
      const res = await request(app.getHttpServer()).get('/notifications?userId=otro').set(bearer());
      expect(res.status).toBe(400);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /notifications/unread-count', () => {
    it('devuelve { count } y NO se interpreta "unread-count" como un id', async () => {
      service.unreadCount.mockResolvedValue(4);
      const res = await request(app.getHttpServer()).get('/notifications/unread-count').set(bearer('cust-2'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 4 });
      expect(service.unreadCount).toHaveBeenCalledWith('cust-2');
    });
  });

  describe('POST /notifications/read-all', () => {
    it('marca todas las del usuario del token y responde 200 con la cantidad', async () => {
      service.markAllRead.mockResolvedValue({ updated: 3 });
      const res = await request(app.getHttpServer()).post('/notifications/read-all').set(bearer('cust-3'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 3 });
      expect(service.markAllRead).toHaveBeenCalledWith('cust-3');
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    it('marca una como leída para el usuario del token', async () => {
      const res = await request(app.getHttpServer()).patch(`/notifications/${ID}/read`).set(bearer('cust-4'));
      expect(res.status).toBe(200);
      expect(service.markRead).toHaveBeenCalledWith('cust-4', ID);
    });

    it('un id mal formado responde 400 sin llegar al servicio', async () => {
      const res = await request(app.getHttpServer()).patch('/notifications/no-es-un-id/read').set(bearer());
      expect(res.status).toBe(400);
      expect(service.markRead).not.toHaveBeenCalled();
    });

    it('si el servicio dice que no existe (o es de otro), propaga el 404', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      service.markRead.mockRejectedValue(new NotFoundException('Notificación no encontrada'));
      const res = await request(app.getHttpServer()).patch(`/notifications/${ID}/read`).set(bearer());
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ statusCode: 404, message: 'Notificación no encontrada', path: `/notifications/${ID}/read` });
    });
  });

  it('no existen rutas para crear ni borrar notificaciones: solo las crean los eventos', async () => {
    expect((await request(app.getHttpServer()).post('/notifications').set(bearer()).send({})).status).toBe(404);
    expect((await request(app.getHttpServer()).delete(`/notifications/${ID}`).set(bearer())).status).toBe(404);
  });

  it('Swagger documenta las cuatro rutas', () => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build());
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/notifications',
      '/notifications/read-all',
      '/notifications/unread-count',
      '/notifications/{id}/read',
    ]);
  });
});
