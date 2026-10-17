import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.provider';

const VERSION_KEY = 'restaurants:version';

/**
 * Caché "cache-aside" sobre Redis:
 *   1. se busca en Redis; si está (HIT) se devuelve;
 *   2. si no (MISS) se pide a MongoDB, se guarda en Redis con un TTL y se devuelve.
 *
 * Tres decisiones que conviene entender:
 *
 * - INVALIDACIÓN POR VERSIÓN. Todas las claves llevan un número de versión (`restaurants:v7:...`).
 *   Cuando alguien modifica un restaurante o su carta se incrementa ese número, y las claves viejas
 *   quedan inalcanzables (se limpian solas por TTL). Se evita así buscar y borrar claves una por una,
 *   y además se evita una carrera: si una lectura lenta cargó datos viejos mientras alguien escribía,
 *   los guarda bajo la versión vieja, que ya nadie lee.
 *
 * - SI REDIS FALLA, NO FALLA EL PEDIDO. Cualquier error de Redis se trata como un MISS: se va a MongoDB.
 *   El caché acelera, pero el servicio no depende de él.
 *
 * - UNA SOLA CARGA POR CLAVE. Si llegan 100 pedidos juntos por una clave que no está, solo uno consulta
 *   MongoDB y los otros 99 esperan ese mismo resultado (evita la "estampida" cuando vence una clave).
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    config: ConfigService,
  ) {
    const ttl = Number(config.get('CACHE_TTL_SECONDS') ?? 60);
    this.ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 60;
  }

  /** Deja en el log si el caché quedó prendido o apagado: evita medir "sin caché" creyendo que está prendido. */
  onModuleInit(): void {
    this.logger.log(
      this.redis ? `Caché ACTIVADO (Redis, vencimiento ${this.ttlSeconds} s)` : 'Caché DESACTIVADO (no hay REDIS_URL): todo se lee de MongoDB',
    );
  }

  get enabled(): boolean {
    return this.redis !== null;
  }

  /** Arma la clave a partir de partes. Las partes de largo variable (búsquedas) se resumen con un hash. */
  static key(...parts: Array<string | number | boolean | undefined>): string {
    return parts.map((p) => (p === undefined ? '' : String(p))).join(':');
  }

  static hash(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
  }

  /** Devuelve el valor cacheado o, si no está, lo calcula con `loader` y lo guarda. */
  async wrap<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const redis = this.redis;
    if (!redis) return loader();

    const version = await this.currentVersion(redis);
    if (version === null) return loader(); // Redis no responde: directo a MongoDB

    const fullKey = `restaurants:v${version}:${key}`;
    const cached = await this.safe(() => redis.get(fullKey));
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // Valor corrupto: se ignora y se recalcula (queda pisado al guardar)
      }
    }

    const pending = this.inflight.get(fullKey);
    if (pending) return pending as Promise<T>;

    const load = (async () => {
      const value = await loader();
      // JSON.stringify aplica el toJSON de Mongoose, así que lo guardado es exactamente lo que ve el cliente
      await this.safe(() => redis.set(fullKey, JSON.stringify(value), 'EX', this.ttlSeconds));
      return value;
    })().finally(() => this.inflight.delete(fullKey));

    this.inflight.set(fullKey, load);
    return load;
  }

  /** Descarta todo lo cacheado: se llama después de cualquier escritura. */
  async invalidate(): Promise<void> {
    const redis = this.redis;
    if (!redis) return;
    await this.safe(() => redis.incr(VERSION_KEY));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  private async currentVersion(redis: Redis): Promise<string | null> {
    const result = await this.safe(async () => (await redis.get(VERSION_KEY)) ?? '0');
    return result ?? null;
  }

  /** Ejecuta un comando de Redis; ante cualquier error devuelve null en vez de propagarlo. */
  private async safe<T>(command: () => Promise<T>): Promise<T | null> {
    try {
      return await command();
    } catch (error) {
      this.logger.debug(`Redis falló: ${(error as Error).message}`);
      return null;
    }
  }
}
