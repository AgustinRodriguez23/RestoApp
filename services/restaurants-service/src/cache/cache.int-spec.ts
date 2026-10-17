import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CacheService } from './cache.service';
import { redisProvider } from './redis.provider';

/**
 * Prueba el caché contra un Redis REAL (local o el service container del CI).
 * REDIS_URL por defecto: redis://localhost:6379
 */
const URL = process.env.REDIS_URL || 'redis://localhost:6379';

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/** Crea el cliente igual que lo hace la app (mismas opciones de timeout y reconexión). */
const createClient = (url: string) =>
  (redisProvider as unknown as { useFactory: (c: ConfigService) => Redis | null }).useFactory(
    config({ REDIS_URL: url }),
  ) as Redis;

describe('CacheService con Redis real', () => {
  let admin: Redis;
  const clients: Redis[] = [];

  /** Crea el caché y, salvo que se pida lo contrario, espera a que el cliente termine de conectar. */
  const newCache = async (url = URL, values: Record<string, string> = {}, waitReady = true) => {
    const client = createClient(url);
    clients.push(client);
    if (waitReady) await new Promise<void>((resolve) => client.once('ready', () => resolve()));
    return { client, cache: new CacheService(client, config(values)) };
  };

  beforeAll(async () => {
    admin = new Redis(URL);
    await admin.ping();
  });

  beforeEach(async () => {
    await admin.flushdb();
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
    await admin.quit();
  });

  it('MISS y después HIT, y la clave queda guardada con TTL', async () => {
    const { cache } = await newCache(URL, { CACHE_TTL_SECONDS: '30' });
    const loader = jest.fn().mockResolvedValue({ id: '1', name: 'La Parrilla' });

    await cache.wrap('one:1', loader);
    const hit = await cache.wrap('one:1', loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(hit).toEqual({ id: '1', name: 'La Parrilla' });

    const [key] = await admin.keys('restaurants:v0:one:1');
    expect(key).toBeDefined();
    const ttl = await admin.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('dos instancias del servicio comparten el caché y la invalidación de una afecta a la otra', async () => {
    const a = (await newCache()).cache;
    const b = (await newCache()).cache;

    await a.wrap('one:1', async () => 'v1');
    await expect(b.wrap('one:1', async () => 'no debería llamarse')).resolves.toBe('v1');

    await a.invalidate(); // la instancia A recibe una modificación

    await expect(b.wrap('one:1', async () => 'v2')).resolves.toBe('v2');
  });

  it('la clave de versión no vence (si venciera, volverían a verse datos viejos)', async () => {
    const { cache } = await newCache();
    await cache.invalidate();
    expect(await admin.get('restaurants:version')).toBe('1');
    expect(await admin.ttl('restaurants:version')).toBe(-1);
  });

  it('con Redis inalcanzable responde desde la base y rápido (no se queda esperando)', async () => {
    const { cache } = await newCache('redis://127.0.0.1:1', {}, false); // puerto donde no hay nada
    const loader = jest.fn().mockResolvedValue('desde mongo');

    const started = Date.now();
    const result = await cache.wrap('k', loader);
    await cache.invalidate();

    expect(result).toBe('desde mongo');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('si Redis se corta con la app andando, sigue respondiendo desde la base', async () => {
    const { cache, client } = await newCache();
    await cache.wrap('k', async () => 'v1');

    client.disconnect(); // equivale a que el contenedor de Redis se caiga
    const loader = jest.fn().mockResolvedValue('desde mongo');

    await expect(cache.wrap('k', loader)).resolves.toBe('desde mongo');
    await expect(cache.invalidate()).resolves.toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('un HIT es mucho más rápido que un MISS contra una base lenta', async () => {
    const { cache } = await newCache();
    const slowDb = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 50)); // una consulta "lenta"
      return { big: 'payload' };
    });

    const t0 = Date.now();
    await cache.wrap('k', slowDb);
    const miss = Date.now() - t0;

    const t1 = Date.now();
    await cache.wrap('k', slowDb);
    const hit = Date.now() - t1;

    expect(miss).toBeGreaterThanOrEqual(45);
    expect(hit).toBeLessThan(miss / 2);
    expect(slowDb).toHaveBeenCalledTimes(1);
  });
});
