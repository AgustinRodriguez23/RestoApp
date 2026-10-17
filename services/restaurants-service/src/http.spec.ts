import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { MenuController } from './menu/menu.controller';
import { MenuService } from './menu/menu.service';
import { RestaurantsController } from './restaurants/restaurants.controller';
import { RestaurantsService } from './restaurants/restaurants.service';
import { Role } from './security/role.enum';
import { SecurityModule } from './security/security.module';

/**
 * Pruebas de la capa HTTP: rutas, validación de entrada, JWT, roles y formato de errores.
 * Los servicios están simulados (no hay base de datos): lo que se prueba acá es que
 * el "cableado" de la API se comporte bien antes de llegar a la lógica de negocio.
 */
describe('API HTTP de restaurants-service', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const restaurants = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findPublic: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const menu = { getMenu: jest.fn(), addItem: jest.fn(), updateItem: jest.fn(), removeItem: jest.fn() };

  const ID = '64b7f0c2a1b2c3d4e5f60718';
  const ITEM_ID = '64b7f0c2a1b2c3d4e5f60999';

  const validRestaurant = {
    name: 'La Parrilla',
    cuisine: 'Parrilla',
    address: 'Av. Mitre 1234',
    openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
    tables: [{ number: 1, capacity: 4 }],
  };
  const validDish = { category: 'Postres', name: 'Flan', priceCents: 450000 };

  const tokenFor = (role: Role, sub = 'user-1') => jwt.sign({ sub, email: `${sub}@example.com`, role });
  const ownerToken = () => tokenFor(Role.RESTAURANT_OWNER, 'owner-1');
  const customerToken = () => tokenFor(Role.CUSTOMER, 'customer-1');
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: 'secreto-solo-para-tests' })],
        }),
        SecurityModule,
      ],
      controllers: [RestaurantsController, MenuController],
      providers: [
        { provide: RestaurantsService, useValue: restaurants },
        { provide: MenuService, useValue: menu },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('rutas públicas', () => {
    it('GET /restaurants usa los valores por defecto de paginación', async () => {
      restaurants.findAll.mockResolvedValue({ data: [], page: 1, limit: 10, total: 0, totalPages: 0 });

      await request(app.getHttpServer()).get('/restaurants').expect(200);

      expect(restaurants.findAll).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 10 }));
    });

    it('GET /restaurants convierte los query params a número', async () => {
      restaurants.findAll.mockResolvedValue({ data: [] });

      await request(app.getHttpServer()).get('/restaurants?page=2&limit=5&cuisine=Pizza').expect(200);

      expect(restaurants.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 5, cuisine: 'Pizza' }),
      );
    });

    it('GET /restaurants rechaza un limit mayor al máximo', async () => {
      await request(app.getHttpServer()).get('/restaurants?limit=999').expect(400);
      expect(restaurants.findAll).not.toHaveBeenCalled();
    });

    it('GET /restaurants/:id rechaza un id que no es un ObjectId', async () => {
      const res = await request(app.getHttpServer()).get('/restaurants/no-es-un-id').expect(400);

      expect(res.body.message).toMatch(/formato/);
      expect(restaurants.findPublic).not.toHaveBeenCalled();
    });

    it('GET /restaurants/:id devuelve el detalle público (por la vía cacheada)', async () => {
      restaurants.findPublic.mockResolvedValue({ id: ID, name: 'La Parrilla' });

      const res = await request(app.getHttpServer()).get(`/restaurants/${ID}`).expect(200);

      expect(res.body).toEqual({ id: ID, name: 'La Parrilla' });
      expect(restaurants.findPublic).toHaveBeenCalledWith(ID);
    });

    it('GET /restaurants/:id/menu pasa includeUnavailable solo si es exactamente "true"', async () => {
      menu.getMenu.mockResolvedValue([]);

      await request(app.getHttpServer()).get(`/restaurants/${ID}/menu`).expect(200);
      await request(app.getHttpServer()).get(`/restaurants/${ID}/menu?includeUnavailable=true`).expect(200);

      expect(menu.getMenu).toHaveBeenNthCalledWith(1, ID, false);
      expect(menu.getMenu).toHaveBeenNthCalledWith(2, ID, true);
    });
  });

  describe('autenticación y roles', () => {
    it('POST /restaurants sin token responde 401 con el formato estándar de error', async () => {
      const res = await request(app.getHttpServer()).post('/restaurants').send(validRestaurant).expect(401);

      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 401,
          error: expect.any(String),
          message: expect.any(String),
          path: '/restaurants',
          timestamp: expect.any(String),
        }),
      );
    });

    it('POST /restaurants con un token adulterado responde 401', async () => {
      const forged = `${ownerToken()}x`;

      await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(forged))
        .send(validRestaurant)
        .expect(401);
    });

    it('POST /restaurants con un token firmado con otro secreto responde 401', async () => {
      const foreign = new JwtService({ secret: 'otro-secreto' }).sign({
        sub: 'hacker',
        role: Role.RESTAURANT_OWNER,
      });

      await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(foreign))
        .send(validRestaurant)
        .expect(401);
      expect(restaurants.create).not.toHaveBeenCalled();
    });

    it('POST /restaurants con rol CUSTOMER responde 403', async () => {
      await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(customerToken()))
        .send(validRestaurant)
        .expect(403);
      expect(restaurants.create).not.toHaveBeenCalled();
    });

    it('un CUSTOMER tampoco puede tocar la carta', async () => {
      await request(app.getHttpServer())
        .post(`/restaurants/${ID}/menu-items`)
        .set(bearer(customerToken()))
        .send(validDish)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/restaurants/${ID}/menu-items/${ITEM_ID}`)
        .set(bearer(customerToken()))
        .expect(403);
      expect(menu.addItem).not.toHaveBeenCalled();
      expect(menu.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('crear y modificar restaurantes', () => {
    it('POST /restaurants toma el dueño del token y responde 201', async () => {
      restaurants.create.mockResolvedValue({ id: ID });

      await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(ownerToken()))
        .send(validRestaurant)
        .expect(201);

      expect(restaurants.create).toHaveBeenCalledWith('owner-1', expect.objectContaining({ name: 'La Parrilla' }));
    });

    it('POST /restaurants no deja que el cliente elija el dueño (ownerId en el body se rechaza)', async () => {
      await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(ownerToken()))
        .send({ ...validRestaurant, ownerId: 'otro-usuario' })
        .expect(400);
      expect(restaurants.create).not.toHaveBeenCalled();
    });

    it('POST /restaurants valida los datos anidados y devuelve todos los errores', async () => {
      const res = await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(ownerToken()))
        .send({
          ...validRestaurant,
          name: 'A',
          openingHours: [{ dayOfWeek: 9, opens: '25:00', closes: '23:30' }],
          tables: [{ number: 1, capacity: 0 }],
        })
        .expect(400);

      const messages = (res.body.message as string[]).join(' | ');
      expect(Array.isArray(res.body.message)).toBe(true);
      expect(messages).toMatch(/name/);
      expect(messages).toMatch(/dayOfWeek/);
      expect(messages).toMatch(/opens/);
      expect(messages).toMatch(/capacity/);
      expect(restaurants.create).not.toHaveBeenCalled();
    });

    it('POST /restaurants exige al menos una mesa', async () => {
      await request(app.getHttpServer())
        .post('/restaurants')
        .set(bearer(ownerToken()))
        .send({ ...validRestaurant, tables: [] })
        .expect(400);
    });

    it('PATCH /restaurants/:id acepta cambios parciales', async () => {
      restaurants.update.mockResolvedValue({ id: ID });

      await request(app.getHttpServer())
        .patch(`/restaurants/${ID}`)
        .set(bearer(ownerToken()))
        .send({ name: 'Nuevo nombre' })
        .expect(200);

      expect(restaurants.update).toHaveBeenCalledWith(ID, 'owner-1', { name: 'Nuevo nombre' });
    });

    it('PATCH /restaurants/:id sigue validando los campos que sí se envían', async () => {
      await request(app.getHttpServer())
        .patch(`/restaurants/${ID}`)
        .set(bearer(ownerToken()))
        .send({ phone: 'abc' })
        .expect(400);
    });

    it('DELETE /restaurants/:id responde 204 sin cuerpo', async () => {
      restaurants.remove.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .delete(`/restaurants/${ID}`)
        .set(bearer(ownerToken()))
        .expect(204);

      expect(res.text).toBe('');
      expect(restaurants.remove).toHaveBeenCalledWith(ID, 'owner-1');
    });
  });

  describe('carta', () => {
    it('POST /menu-items crea un plato con precio en centavos', async () => {
      menu.addItem.mockResolvedValue({ id: ITEM_ID });

      await request(app.getHttpServer())
        .post(`/restaurants/${ID}/menu-items`)
        .set(bearer(ownerToken()))
        .send({
          ...validDish,
          allergens: ['GLUTEN', 'MILK'],
          variants: [{ name: 'Porción grande', priceDeltaCents: 100000 }],
        })
        .expect(201);

      expect(menu.addItem).toHaveBeenCalledWith(
        ID,
        'owner-1',
        expect.objectContaining({ priceCents: 450000, allergens: ['GLUTEN', 'MILK'] }),
      );
    });

    it.each([
      ['un alérgeno inexistente', { ...validDish, allergens: ['CHOCOLATE'] }],
      ['alérgenos repetidos', { ...validDish, allergens: ['MILK', 'MILK'] }],
      ['un precio con decimales', { ...validDish, priceCents: 12.5 }],
      ['un precio negativo', { ...validDish, priceCents: -1 }],
      ['un precio como texto', { ...validDish, priceCents: '4500' }],
      ['una variante sin nombre', { ...validDish, variants: [{ priceDeltaCents: 10 }] }],
    ])('POST /menu-items rechaza %s', async (_label, body) => {
      await request(app.getHttpServer())
        .post(`/restaurants/${ID}/menu-items`)
        .set(bearer(ownerToken()))
        .send(body)
        .expect(400);
      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('PATCH /menu-items/:itemId permite marcar un plato como no disponible', async () => {
      menu.updateItem.mockResolvedValue({ id: ITEM_ID });

      await request(app.getHttpServer())
        .patch(`/restaurants/${ID}/menu-items/${ITEM_ID}`)
        .set(bearer(ownerToken()))
        .send({ available: false })
        .expect(200);

      expect(menu.updateItem).toHaveBeenCalledWith(ID, ITEM_ID, 'owner-1', { available: false });
    });

    it('DELETE /menu-items/:itemId valida ambos ids', async () => {
      await request(app.getHttpServer())
        .delete(`/restaurants/${ID}/menu-items/xyz`)
        .set(bearer(ownerToken()))
        .expect(400);
      expect(menu.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('documentación Swagger', () => {
    it('se genera sin errores y documenta las rutas principales con seguridad Bearer', () => {
      const config = new DocumentBuilder().setTitle('Test').addBearerAuth().build();
      const doc = SwaggerModule.createDocument(app, config);

      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/restaurants',
          '/restaurants/{id}',
          '/restaurants/{restaurantId}/menu',
          '/restaurants/{restaurantId}/menu-items',
          '/restaurants/{restaurantId}/menu-items/{itemId}',
        ]),
      );
      expect(doc.paths['/restaurants'].post?.security).toEqual([{ bearer: [] }]);
      expect(doc.paths['/restaurants'].get?.security).toBeUndefined();
    });
  });
});
