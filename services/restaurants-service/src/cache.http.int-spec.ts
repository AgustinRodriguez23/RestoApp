import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { configureApp } from './app.setup';
import { CacheService } from './cache/cache.service';
import { REDIS_CLIENT, redisProvider } from './cache/redis.provider';
import { MenuController } from './menu/menu.controller';
import { MenuService } from './menu/menu.service';
import { MenuItem } from './menu/schemas/menu-item.schema';
import { RestaurantsController } from './restaurants/restaurants.controller';
import { RestaurantsService } from './restaurants/restaurants.service';
import { Restaurant } from './restaurants/schemas/restaurant.schema';
import { Role } from './security/role.enum';
import { SecurityModule } from './security/security.module';

/**
 * Prueba de punta a punta del caché a través de HTTP: controladores y servicios REALES, Redis REAL,
 * y modelos de Mongoose falsos en memoria que CUENTAN cuántas veces se los consulta.
 * Así se comprueba lo que importa: qué pedidos llegan a la base y cuáles no.
 */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const ID = '64b7f0c2a1b2c3d4e5f60718';
const OWNER = 'owner-1';

/** Documento falso con el mismo `toJSON` que aplica Mongoose (id en vez de _id). */
const doc = (data: Record<string, unknown>) => ({
  ...data,
  toJSON: () => ({ ...data, id: ID }),
});

function buildFakes() {
  const state = { restaurant: { name: 'La Parrilla', ownerId: OWNER, cuisine: 'Parrilla' } as Record<string, unknown> | null };
  const menuState = { items: [{ category: 'Postres', name: 'Flan', available: true }] };

  const restaurantModel = {
    findById: jest.fn(async () => (state.restaurant ? doc(state.restaurant) : null)),
    find: jest.fn(() => ({
      sort: () => ({ skip: () => ({ limit: async () => (state.restaurant ? [doc(state.restaurant)] : []) }) }),
    })),
    countDocuments: jest.fn(async () => (state.restaurant ? 1 : 0)),
    create: jest.fn(async (data: Record<string, unknown>) => {
      state.restaurant = data;
      return doc(data);
    }),
    findByIdAndUpdate: jest.fn(async (_id: string, changes: Record<string, unknown>) => {
      state.restaurant = { ...state.restaurant, ...changes };
      return doc(state.restaurant);
    }),
    findByIdAndDelete: jest.fn(async () => {
      state.restaurant = null;
    }),
  };
  const menuModel = {
    deleteMany: jest.fn(async () => undefined),
    create: jest.fn(async (data: Record<string, unknown>) => {
      menuState.items.push(data as never);
      return doc(data);
    }),
    find: jest.fn(() => ({ sort: async () => menuState.items.map((i) => doc(i)) })),
    findOneAndUpdate: jest.fn(async (_filter: unknown, changes: Record<string, unknown>) => {
      menuState.items[0] = { ...menuState.items[0], ...changes } as never;
      return doc(menuState.items[0]);
    }),
    findOneAndDelete: jest.fn(async () => doc({})),
  };
  return { restaurantModel, menuModel, state };
}

async function buildApp(redisUrl: string) {
  const fakes = buildFakes();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET: 'secreto-solo-para-tests', REDIS_URL: redisUrl, CACHE_TTL_SECONDS: '60' })],
      }),
      SecurityModule,
    ],
    controllers: [RestaurantsController, MenuController],
    providers: [
      RestaurantsService,
      MenuService,
      CacheService,
      redisProvider,
      { provide: getModelToken(Restaurant.name), useValue: fakes.restaurantModel },
      { provide: getModelToken(MenuItem.name), useValue: fakes.menuModel },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  // Esperar a que Redis termine de conectar (en producción, los primeros pedidos tras arrancar simplemente van a Mongo)
  if (redisUrl) {
    const client = app.get<Redis>(REDIS_CLIENT);
    if (client.status !== 'ready') await new Promise<void>((resolve) => client.once('ready', () => resolve()));
  }
  const jwt = app.get(JwtService);
  const token = jwt.sign({ sub: OWNER, email: 'o@example.com', role: Role.RESTAURANT_OWNER });
  return { app, token, ...fakes };
}

describe('caché a través de HTTP (Redis real)', () => {
  let admin: Redis;
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const http = () => request(ctx.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeAll(async () => {
    admin = new Redis(REDIS_URL);
    await admin.ping();
  });
  afterAll(async () => {
    await admin.quit();
  });

  describe('con caché', () => {
    beforeEach(async () => {
      await admin.flushdb();
      ctx = await buildApp(REDIS_URL);
    });
    afterEach(async () => {
      await ctx.app.close();
    });

    it('el detalle: el segundo GET no llega a la base y la respuesta es idéntica', async () => {
      const first = await http().get(`/restaurants/${ID}`).expect(200);
      const second = await http().get(`/restaurants/${ID}`).expect(200);

      expect(ctx.restaurantModel.findById).toHaveBeenCalledTimes(1);
      expect(second.body).toEqual(first.body);
      expect(first.body).toMatchObject({ id: ID, name: 'La Parrilla' });
    });

    it('modificar el restaurante: el siguiente GET ya trae el dato nuevo', async () => {
      await http().get(`/restaurants/${ID}`).expect(200); // queda cacheado
      await http().patch(`/restaurants/${ID}`).set(auth()).send({ name: 'La Parrilla Nueva' }).expect(200);

      const after = await http().get(`/restaurants/${ID}`).expect(200);

      expect(after.body.name).toBe('La Parrilla Nueva');
    });

    it('el listado se cachea y una alta lo refresca', async () => {
      await http().get('/restaurants').expect(200);
      await http().get('/restaurants').expect(200);
      expect(ctx.restaurantModel.find).toHaveBeenCalledTimes(1);

      await http()
        .post('/restaurants')
        .set(auth())
        .send({
          name: 'Nuevo',
          cuisine: 'Pizza',
          address: 'Calle 1',
          openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '23:00' }],
          tables: [{ number: 1, capacity: 2 }],
        })
        .expect(201);
      await http().get('/restaurants').expect(200);

      expect(ctx.restaurantModel.find).toHaveBeenCalledTimes(2);
    });

    it('las búsquedas por texto NO se cachean', async () => {
      await http().get('/restaurants?search=parri').expect(200);
      await http().get('/restaurants?search=parri').expect(200);

      expect(ctx.restaurantModel.find).toHaveBeenCalledTimes(2);
    });

    it('un 404 no se cachea: si el restaurante aparece después, se ve', async () => {
      ctx.state.restaurant = null;
      await http().get(`/restaurants/${ID}`).expect(404);
      await http().get(`/restaurants/${ID}`).expect(404);
      expect(ctx.restaurantModel.findById).toHaveBeenCalledTimes(2);

      ctx.state.restaurant = { name: 'Apareció', ownerId: OWNER };
      await http().get(`/restaurants/${ID}`).expect(200);
    });

    it('borrar el restaurante: el GET siguiente responde 404 y no el dato viejo', async () => {
      await http().get(`/restaurants/${ID}`).expect(200);
      await http().delete(`/restaurants/${ID}`).set(auth()).expect(204);

      await http().get(`/restaurants/${ID}`).expect(404);
    });

    it('la carta se cachea y se refresca al modificar un plato', async () => {
      await http().get(`/restaurants/${ID}/menu`).expect(200);
      await http().get(`/restaurants/${ID}/menu`).expect(200);
      expect(ctx.menuModel.find).toHaveBeenCalledTimes(1);

      await http()
        .patch(`/restaurants/${ID}/menu-items/64b7f0c2a1b2c3d4e5f60999`)
        .set(auth())
        .send({ name: 'Flan con dulce de leche' })
        .expect(200);
      const after = await http().get(`/restaurants/${ID}/menu`).expect(200);

      expect(ctx.menuModel.find).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(after.body)).toContain('Flan con dulce de leche');
    });

    it('la carta con y sin platos no disponibles se guardan por separado', async () => {
      await http().get(`/restaurants/${ID}/menu`).expect(200);
      await http().get(`/restaurants/${ID}/menu?includeUnavailable=true`).expect(200);

      expect(ctx.menuModel.find).toHaveBeenCalledTimes(2);
    });
  });

  describe('sin caché (REDIS_URL vacía): el comportamiento de antes de la Fase 8', () => {
    beforeEach(async () => {
      ctx = await buildApp('');
    });
    afterEach(async () => {
      await ctx.app.close();
    });

    it('cada GET llega a la base', async () => {
      await http().get(`/restaurants/${ID}`).expect(200);
      await http().get(`/restaurants/${ID}`).expect(200);
      await http().get(`/restaurants/${ID}`).expect(200);

      expect(ctx.restaurantModel.findById).toHaveBeenCalledTimes(3);
    });
  });
});
