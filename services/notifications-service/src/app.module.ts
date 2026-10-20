import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthController } from './health/health.controller';
import { MessagingModule } from './messaging/messaging.module';
import { NotificationsModule } from './notifications/notifications.module';

/** Arma la URI desde las variables NOTIFICATIONS_MONGO_* del .env de la raíz. */
function buildMongoUri(config: ConfigService): string {
  const user = encodeURIComponent(config.get<string>('NOTIFICATIONS_MONGO_USER', 'notifications'));
  const password = encodeURIComponent(config.get<string>('NOTIFICATIONS_MONGO_PASSWORD', 'notifications_password'));
  const host = config.get<string>('NOTIFICATIONS_MONGO_HOST', 'localhost');
  const port = config.get<string>('NOTIFICATIONS_MONGO_PORT', '27019');
  const db = config.get<string>('NOTIFICATIONS_MONGO_DB', 'notifications_db');
  return `mongodb://${user}:${password}@${host}:${port}/${db}?authSource=admin`;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Al correr con `npm run dev:notifications` el directorio actual es services/notifications-service,
      // así que también se lee el .env de la raíz del monorepo (el mismo que usa docker compose).
      envFilePath: ['.env', '../../.env'],
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // MONGO_URI la define docker-compose para el contenedor; en local se arma con las partes.
        uri: config.get<string>('MONGO_URI') ?? buildMongoUri(config),
      }),
    }),
    MessagingModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
