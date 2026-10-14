import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { EventEnvelope } from '../event-envelope';

/**
 * Bandeja de salida (transactional outbox).
 *
 * El problema que resuelve: "guardar en mi base" y "avisar por RabbitMQ" son dos sistemas distintos y
 * no hay transacción que abarque a los dos. Si se guarda y se cae antes de publicar, el evento se
 * pierde; si se publica y falla el guardado, se avisó algo que no pasó.
 * La solución: el evento se guarda como una fila en la MISMA transacción que el cambio de negocio
 * (o ambos o ninguno) y un proceso aparte (OutboxRelay) lo publica después, reintentando hasta lograrlo.
 * El precio: la entrega es "al menos una vez" (puede duplicarse), por eso los consumidores son idempotentes.
 */
@Entity('outbox_messages')
@Index(['publishedAt', 'nextAttemptAt'])
export class OutboxMessage {
  /** Es el mismo id que lleva el sobre del evento. */
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  type: string;

  @Column({ type: 'jsonb' })
  payload: EventEnvelope;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;
}
