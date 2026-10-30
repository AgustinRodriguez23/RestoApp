import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { OutboxMessage } from './messaging/entities/outbox-message.entity';
import { ProcessedMessage } from './messaging/entities/processed-message.entity';
import { migrations } from './migrations';
import { Reservation } from './reservations/entities/reservation.entity';

/**
 * Opciones de conexión a PostgreSQL. Las usan la app y la CLI de migraciones (data-source.ts).
 * DB_* lo define docker-compose para el contenedor; RESERVATIONS_DB_* viene del .env de la raíz.
 */
export function typeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  const db = (name: string) =>
    config.get<string>(`DB_${name}`) ?? config.get<string>(`RESERVATIONS_DB_${name}`);
  const schema = db('SCHEMA') || undefined;

  return {
    type: 'postgres',
    host: db('HOST') ?? 'localhost',
    port: Number(db('PORT') ?? 5434),
    username: db('USER') ?? 'reservations',
    password: db('PASSWORD') ?? 'reservations_password',
    database: db('NAME') ?? 'reservations_db',
    // Schema propio del servicio (vacío = el "public" por defecto). Los tests de integración
    // lo usan para trabajar en un schema temporal sin tocar tus datos. Tiene que existir de antemano.
    schema,
    // Las migraciones escriben "reservations", no "<schema>"."reservations": con el search_path en el schema
    // del servicio, sus tablas caen ahí. public va después para seguir viendo las extensiones.
    extra: schema ? { options: `-c search_path=${schema},public` } : undefined,
    entities: [Reservation, OutboxMessage, ProcessedMessage],
    // El esquema lo definen las migraciones (src/migrations), que se aplican al arrancar, antes de atender pedidos.
    // synchronize no se usa nunca: deduce los cambios comparando las entidades con la base, y por ejemplo para
    // agrandar un varchar borra la columna (con sus datos) y la vuelve a crear vacía.
    migrations,
    migrationsRun: true,
    // Las extensiones las crea la migración inicial. Si las instalara el driver al conectar, caerían en el
    // primer schema del search_path (el temporal de un test) y desaparecerían con él.
    installExtensions: false,
    synchronize: false,
  };
}
