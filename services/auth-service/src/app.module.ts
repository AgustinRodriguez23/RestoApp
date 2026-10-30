import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { typeOrmOptions } from './database.config';
import { HealthController } from './health/health.controller';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Al correr con `npm run dev:auth` el directorio actual es services/auth-service,
      // así que también se lee el .env de la raíz del monorepo (el mismo que usa docker compose).
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: typeOrmOptions }),
    UsersModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
