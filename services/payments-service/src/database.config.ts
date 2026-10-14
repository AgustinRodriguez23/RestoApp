import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { OutboxMessage } from './messaging/entities/outbox-message.entity';
import { ProcessedMessage } from './messaging/entities/processed-message.entity';
import { GatewayEvent } from './payments/entities/gateway-event.entity';
import { IdempotencyKey } from './payments/entities/idempotency-key.entity';
import { Payment } from './payments/entities/payment.entity';

/**
 * Opciones de conexión a PostgreSQL.
 * DB_* lo define docker-compose para el contenedor; PAYMENTS_DB_* viene del .env de la raíz.
 */
export function typeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  const db = (name: string) => config.get<string>(`DB_${name}`) ?? config.get<string>(`PAYMENTS_DB_${name}`);

  return {
    type: 'postgres',
    host: db('HOST') ?? 'localhost',
    port: Number(db('PORT') ?? 5435),
    username: db('USER') ?? 'payments',
    password: db('PASSWORD') ?? 'payments_password',
    database: db('NAME') ?? 'payments_db',
    // Schema propio del servicio (vacío = "public"). Los tests de integración usan uno temporal. Tiene que existir de antemano.
    schema: db('SCHEMA') || undefined,
    entities: [Payment, IdempotencyKey, GatewayEvent, OutboxMessage, ProcessedMessage],
    // synchronize crea las tablas solas: cómodo para desarrollar; en producción se reemplaza por migraciones.
    // DB_SYNCHRONIZE=true/false lo fuerza; sin definir, se activa salvo en producción.
    // (docker-compose lo activa porque las imágenes corren con NODE_ENV=production y todavía no hay migraciones.)
    synchronize:
      config.get<string>('DB_SYNCHRONIZE') !== undefined
        ? config.get<string>('DB_SYNCHRONIZE') === 'true'
        : config.get<string>('NODE_ENV') !== 'production',
  };
}
