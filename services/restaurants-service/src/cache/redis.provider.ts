import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Crea el cliente de Redis, o `null` si REDIS_URL no está definida (o está vacía).
 *
 * Con `null` el servicio funciona exactamente igual que antes de la Fase 8, solo que sin caché.
 * Eso sirve para dos cosas: los tests y el CI no necesitan un Redis, y para medir "antes vs después"
 * alcanza con arrancar el servicio con o sin REDIS_URL.
 *
 * Las opciones están pensadas para que Redis sea una OPTIMIZACIÓN y no una dependencia dura:
 * si se cae, los pedidos tienen que fallar rápido (y caer a MongoDB), no quedarse esperando.
 */
export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis | null => {
    const url = config.get<string>('REDIS_URL')?.trim();
    if (!url) return null;

    const logger = new Logger('Redis');
    const client = new Redis(url, {
      // Si no hay conexión, el comando falla al instante en vez de encolarse esperando que vuelva
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 250,
      // Reintenta reconectar en segundo plano, cada vez más espaciado (máx. 2 s)
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });

    // Sin un listener de 'error', ioredis imprime cada falla de reconexión. Se loguea solo el cambio de estado.
    let down = false;
    client.on('error', (error) => {
      if (down) return;
      down = true;
      logger.warn(`Redis no responde (${error.message}). Se sirve desde MongoDB hasta que vuelva.`);
    });
    client.on('ready', () => {
      if (down) logger.log('Redis volvió a responder');
      down = false;
    });
    return client;
  },
};
