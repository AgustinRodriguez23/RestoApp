import { Module } from '@nestjs/common';
import { EventConsumers } from './event-consumers.service';
import { RabbitConnection } from './rabbit-connection';

@Module({
  providers: [RabbitConnection, EventConsumers],
  exports: [RabbitConnection, EventConsumers],
})
export class MessagingModule {}
