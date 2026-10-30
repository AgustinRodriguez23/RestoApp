import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { migrations } from './migrations';
import { User } from './users/user.entity';

/**
 * Opciones de conexión a PostgreSQL. Las usan la app y la CLI de migraciones (data-source.ts).
 * DB_* lo define docker-compose para el contenedor; AUTH_DB_* viene del .env de la raíz.
 */
export function typeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  const db = (name: string) => config.get<string>(`DB_${name}`) ?? config.get<string>(`AUTH_DB_${name}`);
  const schema = db('SCHEMA') || undefined;

  return {
    type: 'postgres',
    host: db('HOST') ?? 'localhost',
    port: Number(db('PORT') ?? 5433),
    username: db('USER') ?? 'auth',
    password: db('PASSWORD') ?? 'auth_password',
    database: db('NAME') ?? 'auth_db',
    // Proveedores en la nube (ej: Supabase) exigen conexión cifrada.
    // rejectUnauthorized:false acepta su certificado sin validar la CA: alcanza
    // para practicar; en producción real se debería validar con el certificado de la CA.
    ssl: db('SSL') === 'true' ? { rejectUnauthorized: false } : false,
    // Schema propio del servicio (vacío = el "public" por defecto de Postgres). Los tests de integración usan uno temporal.
    schema,
    // Las migraciones escriben "users", no "<schema>"."users": con el search_path en el schema del servicio,
    // sus tablas caen ahí. public va después para seguir viendo las extensiones.
    extra: schema ? { options: `-c search_path=${schema},public` } : undefined,
    entities: [User],
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
