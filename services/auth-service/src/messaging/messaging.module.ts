import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessage } from './entities/outbox-message.entity';
import { OutboxRelay } from './outbox-relay.service';
import { OutboxService } from './outbox.service';
import { RabbitConnection } from './rabbit-connection';

/**
 * Mensajería de auth-service: solo publica (outbox + relay). A diferencia de reservations y payments no escucha
 * ningún evento, así que no tiene consumidores ni la tabla de mensajes procesados.
 * Los archivos son copia de los de reservations-service: si se cambia uno, se cambian todos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessage])],
  providers: [RabbitConnection, OutboxService, OutboxRelay],
  exports: [RabbitConnection, OutboxService, OutboxRelay],
})
export class MessagingModule {}
