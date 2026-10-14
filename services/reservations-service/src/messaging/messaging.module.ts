import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessage } from './entities/outbox-message.entity';
import { ProcessedMessage } from './entities/processed-message.entity';
import { EventConsumers } from './event-consumers.service';
import { OutboxRelay } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { RabbitConnection } from './rabbit-connection';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessage, ProcessedMessage])],
  providers: [RabbitConnection, OutboxService, OutboxRelay, EventConsumers],
  exports: [RabbitConnection, OutboxService, OutboxRelay, EventConsumers],
})
export class MessagingModule {}
