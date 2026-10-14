import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PaymentStatus } from './payment-status.enum';

@Entity('payments')
@Index(['customerId', 'createdAt'])
@Index(['providerChargeId'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Una reserva tiene como mucho UN pago: además de ser la regla de negocio, hace idempotente la creación. */
  @Index({ unique: true })
  @Column({ name: 'reservation_id', type: 'uuid' })
  reservationId: string;

  @Column({ name: 'customer_id', type: 'varchar' })
  customerId: string;

  @Column({ name: 'restaurant_id', type: 'varchar', length: 24 })
  restaurantId: string;

  /** Importe en centavos (nunca decimales para plata). */
  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  /** Hasta cuándo se puede pagar (el límite de la reserva). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Qué pasarela procesó el cobro ('simulated', 'mercadopago'...). */
  @Column({ type: 'varchar', length: 30, nullable: true })
  provider: string | null;

  /** Id del cobro en la pasarela: con él se asocian los webhooks y se hace el reembolso. */
  @Column({ name: 'provider_charge_id', type: 'varchar', nullable: true })
  providerChargeId: string | null;

  @Column({ name: 'provider_refund_id', type: 'varchar', nullable: true })
  providerRefundId: string | null;

  @Column({ name: 'failure_reason', type: 'varchar', length: 200, nullable: true })
  failureReason: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
