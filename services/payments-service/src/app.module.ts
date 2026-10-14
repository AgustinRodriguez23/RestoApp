import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { typeOrmOptions } from './database.config';
import { HealthController } from './health/health.controller';
import { MessagingModule } from './messaging/messaging.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Con `npm run dev:payments` el directorio actual es services/payments-service: también se lee el .env de la raíz.
      envFilePath: ['.env', '../../.env'],
    }),
    TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: typeOrmOptions }),
    MessagingModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
