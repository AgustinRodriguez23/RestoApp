import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Al correr con `npm run dev:auth` el directorio actual es services/auth-service,
      // así que también se lee el .env de la raíz del monorepo (el mismo que usa docker compose).
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // DB_* lo define docker-compose para el contenedor; AUTH_DB_* viene del .env de la raíz.
        const db = (name: string) =>
          config.get<string>(`DB_${name}`) ?? config.get<string>(`AUTH_DB_${name}`);

        return {
          type: 'postgres' as const,
          host: db('HOST') ?? 'localhost',
          port: Number(db('PORT') ?? 5433),
          username: db('USER') ?? 'auth',
          password: db('PASSWORD') ?? 'auth_password',
          database: db('NAME') ?? 'auth_db',
          // Proveedores en la nube (ej: Supabase) exigen conexión cifrada.
          // rejectUnauthorized:false acepta su certificado sin validar la CA: alcanza
          // para practicar; en producción real se debería validar con el certificado de la CA.
          ssl: db('SSL') === 'true' ? { rejectUnauthorized: false } : false,
          // Schema propio del servicio (vacío = el "public" por defecto de Postgres).
          schema: db('SCHEMA') || undefined,
          entities: [User],
          // synchronize crea las tablas solas: cómodo para desarrollar,
          // pero en producción se reemplaza por migraciones.
          synchronize: config.get<string>('NODE_ENV') !== 'production',
        };
      },
    }),
    UsersModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}