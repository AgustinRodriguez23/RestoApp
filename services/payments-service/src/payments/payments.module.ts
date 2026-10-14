import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GatewayModule } from '../gateway/gateway.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SecurityModule } from '../security/security.module';
import { GatewayEvent } from './entities/gateway-event.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { Payment } from './entities/payment.entity';
import { IdempotencyService } from './idempotency.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ReservationEventsConsumer } from './reservation-events.consumer';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [
    SecurityModule,
    MessagingModule,
    GatewayModule,
    TypeOrmModule.forFeature([Payment, IdempotencyKey, GatewayEvent]),
  ],
  controllers: [PaymentsController, WebhooksController],
  providers: [PaymentsService, IdempotencyService, WebhooksService, ReservationEventsConsumer],
})
export class PaymentsModule {}
