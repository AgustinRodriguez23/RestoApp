import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { CacheService } from './cache.service';

/** Redis falso en memoria con solo los comandos que usa CacheService. Permite simular que "se cae". */
class FakeRedis {
  store = new Map<string, string>();
  down = false;
  sets: Array<{ key: string; ttl: unknown }> = [];

  private guard() {
    if (this.down) throw new Error('Stream isn\'t writeable');
  }
  async get(key: string) {
    this.guard();
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _mode: string, ttl: unknown) {
    this.guard();
    this.store.set(key, value);
    this.sets.push({ key, ttl });
    return 'OK';
  }
  async incr(key: string) {
    this.guard();
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return next;
  }
  async quit() {
    return 'OK';
  }
}

const config = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const build = (redis: FakeRedis | null, values: Record<string, unknown> = {}) =>
  new CacheService(redis as unknown as Redis | null, config(values));

describe('CacheService', () => {
  let redis: FakeRedis;
  let cache: CacheService;

  beforeEach(() => {
    redis = new FakeRedis();
    cache = build(redis);
  });

  it('sin Redis configurado no cachea: ejecuta siempre el loader', async () => {
    const off = build(null);
    const loader = jest.fn().mockResolvedValue({ n: 1 });

    await off.wrap('k', loader);
    await off.wrap('k', loader);

    expect(off.enabled).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
    await expect(off.invalidate()).resolves.toBeUndefined();
  });

  it('el primer pedido es MISS (consulta la base) y el segundo es HIT (no la consulta)', async () => {
    const loader = jest.fn().mockResolvedValue({ name: 'La Parrilla' });

    const first = await cache.wrap('one:1', loader);
    const second = await cache.wrap('one:1', loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ name: 'La Parrilla' });
    expect(second).toEqual({ name: 'La Parrilla' });
  });

  it('guarda lo que ve el cliente: aplica el toJSON del objeto (como hace Mongoose)', async () => {
    const doc = { _id: 'abc', toJSON: () => ({ id: 'abc', name: 'X' }) };

    await cache.wrap('k', async () => doc);
    const hit = await cache.wrap('k', async () => {
      throw new Error('no debería consultar la base');
    });

    expect(hit).toEqual({ id: 'abc', name: 'X' });
  });

  it('claves distintas no se pisan', async () => {
    await cache.wrap('one:1', async () => 'uno');
    await expect(cache.wrap('one:2', async () => 'dos')).resolves.toBe('dos');
  });

  it('las claves vencen: se guardan con TTL (60 s por defecto, configurable)', async () => {
    await cache.wrap('k', async () => 1);
    expect(redis.sets[0].ttl).toBe(60);

    const custom = new FakeRedis();
    await build(custom, { CACHE_TTL_SECONDS: '15' }).wrap('k', async () => 1);
    expect(custom.sets[0].ttl).toBe(15);

    const invalid = new FakeRedis();
    await build(invalid, { CACHE_TTL_SECONDS: 'abc' }).wrap('k', async () => 1);
    expect(invalid.sets[0].ttl).toBe(60);
  });

  describe('invalidación', () => {
    it('después de invalidar, el siguiente pedido vuelve a consultar la base', async () => {
      const loader = jest.fn().mockResolvedValueOnce('viejo').mockResolvedValueOnce('nuevo');

      await expect(cache.wrap('k', loader)).resolves.toBe('viejo');
      await cache.invalidate();

      await expect(cache.wrap('k', loader)).resolves.toBe('nuevo');
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('una lectura lenta que empezó ANTES de la escritura no deja datos viejos en el caché', async () => {
      let release!: () => void;
      const slowRead = cache.wrap('k', async () => {
        const stale = 'dato viejo';
        await new Promise<void>((resolve) => (release = resolve)); // la lectura queda "en vuelo"
        return stale;
      });
      await new Promise((r) => setImmediate(r));

      await cache.invalidate(); // alguien modifica el restaurante mientras tanto
      release();
      await slowRead; // la lectura lenta termina y guarda su resultado

      // La siguiente lectura tiene que ir a la base y traer el dato nuevo, no el viejo
      await expect(cache.wrap('k', async () => 'dato nuevo')).resolves.toBe('dato nuevo');
    });
  });

  it('100 pedidos simultáneos por la misma clave consultan la base UNA sola vez', async () => {
    const loader = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    });

    const results = await Promise.all(Array.from({ length: 100 }, () => cache.wrap('k', loader)));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  describe('cuando algo sale mal', () => {
    it('si el loader falla (ej. 404) el error llega al llamador y NO se cachea', async () => {
      const loader = jest.fn().mockRejectedValueOnce(new Error('no existe')).mockResolvedValueOnce('ahora sí');

      await expect(cache.wrap('k', loader)).rejects.toThrow('no existe');
      await expect(cache.wrap('k', loader)).resolves.toBe('ahora sí');
    });

    it('si Redis está caído, el pedido igual se responde desde la base', async () => {
      redis.down = true;
      const loader = jest.fn().mockResolvedValue('desde mongo');

      await expect(cache.wrap('k', loader)).resolves.toBe('desde mongo');
      await expect(cache.wrap('k', loader)).resolves.toBe('desde mongo');
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('invalidar con Redis caído no lanza error', async () => {
      redis.down = true;
      await expect(cache.invalidate()).resolves.toBeUndefined();
    });

    it('si un valor guardado está corrupto, lo ignora y lo recalcula', async () => {
      await cache.wrap('k', async () => 'bueno');
      const [key] = [...redis.store.keys()].filter((k) => k.endsWith(':k'));
      redis.store.set(key, '{esto no es json');

      await expect(cache.wrap('k', async () => 'recalculado')).resolves.toBe('recalculado');
    });
  });

  describe('claves', () => {
    it('key() une las partes y tolera partes vacías', () => {
      expect(CacheService.key('menu', 'abc', true)).toBe('menu:abc:true');
      expect(CacheService.key('list', undefined)).toBe('list:');
    });

    it('hash() da el mismo resultado para el mismo contenido y distinto para otro', () => {
      expect(CacheService.hash({ page: 1 })).toBe(CacheService.hash({ page: 1 }));
      expect(CacheService.hash({ page: 1 })).not.toBe(CacheService.hash({ page: 2 }));
      expect(CacheService.hash({ page: 1 })).toHaveLength(16);
    });
  });
});
