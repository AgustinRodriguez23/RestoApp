import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { OutboxMessage } from './messaging/entities/outbox-message.entity';
import { ProcessedMessage } from './messaging/entities/processed-message.entity';
import { migrations } from './migrations';
import { GatewayEvent } from './payments/entities/gateway-event.entity';
import { IdempotencyKey } from './payments/entities/idempotency-key.entity';
import { Payment } from './payments/entities/payment.entity';

/**
 * Opciones de conexión a PostgreSQL. Las usan la app y la CLI de migraciones (data-source.ts).
 * DB_* lo define docker-compose para el contenedor; PAYMENTS_DB_* viene del .env de la raíz.
 */
export function typeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  const db = (name: string) => config.get<string>(`DB_${name}`) ?? config.get<string>(`PAYMENTS_DB_${name}`);
  const schema = db('SCHEMA') || undefined;

  return {
    type: 'postgres',
    host: db('HOST') ?? 'localhost',
    port: Number(db('PORT') ?? 5435),
    username: db('USER') ?? 'payments',
    password: db('PASSWORD') ?? 'payments_password',
    database: db('NAME') ?? 'payments_db',
    // Schema propio del servicio (vacío = "public"). Los tests de integración usan uno temporal. Tiene que existir de antemano.
    schema,
    // Las migraciones escriben "payments", no "<schema>"."payments": con el search_path en el schema del servicio,
    // sus tablas caen ahí. public va después para seguir viendo las extensiones.
    extra: schema ? { options: `-c search_path=${schema},public` } : undefined,
    entities: [Payment, IdempotencyKey, GatewayEvent, OutboxMessage, ProcessedMessage],
    // El esquema lo definen las migraciones (src/migrations), que se aplican al arrancar; synchronize no se usa
    // nunca (ver el de reservations-service).
    migrations,
    migrationsRun: true,
    // Las extensiones las crea la migración inicial. Si las instalara el driver al conectar, caerían en el
    // primer schema del search_path (el temporal de un test) y desaparecerían con él.
    installExtensions: false,
    synchronize: false,
  };
}
