import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmOptions } from './database.config';
import { HealthController } from './health/health.controller';
import { ReservationsModule } from './reservations/reservations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Al correr con `npm run dev:reservations` el directorio actual es services/reservations-service,
      // así que también se lee el .env de la raíz del monorepo (el mismo que usa docker compose).
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: typeOrmOptions,
    }),
    ReservationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
