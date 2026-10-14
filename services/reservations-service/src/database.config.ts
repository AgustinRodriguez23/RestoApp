import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { OutboxMessage } from './messaging/entities/outbox-message.entity';
import { ProcessedMessage } from './messaging/entities/processed-message.entity';
import { Reservation } from './reservations/entities/reservation.entity';

/**
 * Opciones de conexión a PostgreSQL.
 * DB_* lo define docker-compose para el contenedor; RESERVATIONS_DB_* viene del .env de la raíz.
 */
export function typeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  const db = (name: string) =>
    config.get<string>(`DB_${name}`) ?? config.get<string>(`RESERVATIONS_DB_${name}`);

  return {
    type: 'postgres',
    host: db('HOST') ?? 'localhost',
    port: Number(db('PORT') ?? 5434),
    username: db('USER') ?? 'reservations',
    password: db('PASSWORD') ?? 'reservations_password',
    database: db('NAME') ?? 'reservations_db',
    // Schema propio del servicio (vacío = el "public" por defecto). Los tests de integración
    // lo usan para trabajar en un schema temporal sin tocar tus datos. Tiene que existir de antemano.
    schema: db('SCHEMA') || undefined,
    entities: [Reservation, OutboxMessage, ProcessedMessage],
    // synchronize crea las tablas solas: cómodo para desarrollar,
    // pero en producción se reemplaza por migraciones.
    // DB_SYNCHRONIZE=true/false lo fuerza; sin definir, se activa salvo en producción.
    // (docker-compose lo activa porque las imágenes corren con NODE_ENV=production y todavía no hay migraciones.)
    synchronize:
      config.get<string>('DB_SYNCHRONIZE') !== undefined
        ? config.get<string>('DB_SYNCHRONIZE') === 'true'
        : config.get<string>('NODE_ENV') !== 'production',
  };
}
