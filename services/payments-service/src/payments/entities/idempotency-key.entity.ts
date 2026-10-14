import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Registro de claves de idempotencia de POST /payments/:id/pay.
 * Con la misma clave y el mismo pedido, el cliente recibe SIEMPRE la misma respuesta y el cobro se
 * hace una sola vez (aunque haga doble clic, reintente por un timeout o la red repita el request).
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  /** La clave es por usuario: dos usuarios pueden usar la misma cadena sin pisarse. */
  @PrimaryColumn({ type: 'varchar' })
  scope: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  /** Hash del pedido (qué pago y con qué datos): la misma clave con otro pedido es un error del cliente. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash: string;

  /** Null mientras el primer pedido todavía se está procesando. */
  @Column({ name: 'response_status', type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody: unknown | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
