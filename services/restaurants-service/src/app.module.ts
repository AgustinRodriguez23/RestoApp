import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthController } from './health/health.controller';
import { MenuModule } from './menu/menu.module';
import { RestaurantsModule } from './restaurants/restaurants.module';

/** Arma la URI desde las variables RESTAURANTS_MONGO_* del .env de la raíz. */
function buildMongoUri(config: ConfigService): string {
  const user = encodeURIComponent(config.get<string>('RESTAURANTS_MONGO_USER', 'restaurants'));
  const password = encodeURIComponent(
    config.get<string>('RESTAURANTS_MONGO_PASSWORD', 'restaurants_password'),
  );
  const host = config.get<string>('RESTAURANTS_MONGO_HOST', 'localhost');
  const port = config.get<string>('RESTAURANTS_MONGO_PORT', '27018');
  const db = config.get<string>('RESTAURANTS_MONGO_DB', 'restaurants_db');
  return `mongodb://${user}:${password}@${host}:${port}/${db}?authSource=admin`;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Al correr con `npm run dev:restaurants` el directorio actual es services/restaurants-service,
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
    RestaurantsModule,
    MenuModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
