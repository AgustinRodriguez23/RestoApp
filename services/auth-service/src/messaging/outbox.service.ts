import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { createEnvelope, EventEnvelope } from './event-envelope';
import { OutboxMessage } from './entities/outbox-message.entity';

/**
 * Deja un evento en la bandeja de salida DENTRO de la transacción del que lo llama.
 * Se usa siempre con el `manager` de esa transacción: si la transacción se revierte,
 * el evento desaparece con ella (no se avisa de algo que no ocurrió).
 */
@Injectable()
export class OutboxService {
  async enqueue<T extends object>(manager: EntityManager, type: string, data: T): Promise<EventEnvelope<T>> {
    const envelope = createEnvelope(type, data);
    await manager.insert(OutboxMessage, {
      id: envelope.id,
      type,
      payload: envelope as never, // jsonb: TypeORM no sabe tipar un objeto genérico
    });
    return envelope;
  }
}
