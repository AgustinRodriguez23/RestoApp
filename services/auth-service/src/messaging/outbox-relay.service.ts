import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OutboxMessage } from './entities/outbox-message.entity';
import { RabbitConnection } from './rabbit-connection';
import { runWithContext } from '../observability/request-context';

/**
 * Lee la bandeja de salida y publica los eventos pendientes en RabbitMQ.
 *
 * - `FOR UPDATE SKIP LOCKED`: si hay varias instancias del servicio, cada una toma un lote distinto
 *   sin pisarse ni esperarse (las filas que otra ya tiene tomadas se saltean).
 * - Un evento solo se marca como publicado cuando RabbitMQ confirmó que lo recibió.
 * - Si falla, se reintenta más tarde con espera creciente (backoff exponencial, con tope).
 * - Si el proceso muere entre publicar y marcar, el evento se publica de nuevo: duplicado posible,
 *   y para eso están los consumidores idempotentes.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly rabbit: RabbitConnection,
    config: ConfigService,
  ) {
    this.pollMs = Number(config.get<string>('OUTBOX_POLL_MS') ?? 500);
    this.batchSize = Number(config.get<string>('OUTBOX_BATCH_SIZE') ?? 50);
  }

  onModuleInit(): void {
    if (this.rabbit.enabled) this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Publica un lote de pendientes. Devuelve cuántos publicó. Público para poder probarlo sin esperar al reloj. */
  async flush(): Promise<number> {
    if (!this.rabbit.isUp) return 0;

    return this.dataSource.transaction(async (manager) => {
      const pending = await manager
        .createQueryBuilder(OutboxMessage, 'o')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('o.published_at IS NULL AND o.next_attempt_at <= now()')
        .orderBy('o.created_at', 'ASC')
        .limit(this.batchSize)
        .getMany();

      // Se mandan todos y recién después se espera a RabbitMQ: confirmar de a uno hace que cada evento haga cola
      // detrás del anterior. El orden se mantiene: los publish salen en este orden, por el mismo canal.
      const results = await Promise.allSettled(
        pending.map((message) =>
          // Se publica con el contexto del evento, así el log lleva el correlationId de la saga original
          runWithContext({ correlationId: message.payload.correlationId }, async () => {
            await this.rabbit.publishEvent(message.payload);
            this.logger.log(`Evento publicado: ${message.type} (${message.id})`);
          }),
        ),
      );

      let published = 0;
      for (const [index, result] of results.entries()) {
        const message = pending[index];
        if (result.status === 'fulfilled') {
          await manager.update(OutboxMessage, { id: message.id }, { publishedAt: new Date(), lastError: null });
          published++;
        } else {
          const reason = (result.reason as Error).message;
          const attempts = message.attempts + 1;
          const delayMs = Math.min(2 ** attempts * 1000, 5 * 60_000);
          await manager.update(
            OutboxMessage,
            { id: message.id },
            { attempts, nextAttemptAt: new Date(Date.now() + delayMs), lastError: reason },
          );
          this.logger.warn(`No se pudo publicar ${message.type} (${message.id}), intento ${attempts}: ${reason}`);
        }
      }
      return published;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.flush()
        .catch((error: Error) => this.logger.error(`Falló el relay del outbox: ${error.message}`))
        .finally(() => this.schedule());
    }, this.pollMs);
    this.timer.unref();
  }
}
