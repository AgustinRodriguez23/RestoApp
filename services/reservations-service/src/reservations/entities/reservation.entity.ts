import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReservationStatus } from './reservation-status.enum';

@Entity('reservations')
@Index(['customerId', 'startsAt'])
@Index(['restaurantId', 'startsAt'])
@Index(['status', 'expiresAt'])
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Id (ObjectId de MongoDB) del restaurante en restaurants-service. Referencia lógica, no clave foránea. */
  @Column({ name: 'restaurant_id', type: 'varchar', length: 24 })
  restaurantId: string;

  @Column({ name: 'table_number', type: 'int' })
  tableNumber: number;

  /** Id del usuario (de auth-service) que reservó. */
  @Column({ name: 'customer_id', type: 'varchar' })
  customerId: string;

  /** Nombre del cliente al reservar (copia del JWT). Null en reservas anteriores a este campo. */
  @Column({ name: 'customer_name', type: 'varchar', length: 100, nullable: true })
  customerName: string | null;

  /** Nombre del restaurante al reservar (copia). Va en los eventos para que las notificaciones lo muestren sin consultar a otro servicio. Null en reservas anteriores a este campo. */
  @Column({ name: 'restaurant_name', type: 'varchar', length: 100, nullable: true })
  restaurantName: string | null;

  @Column({ name: 'party_size', type: 'int' })
  partySize: number;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt: Date;

  @Column({ type: 'enum', enum: ReservationStatus, default: ReservationStatus.CONFIRMED })
  status: ReservationStatus;

  @Column({ type: 'varchar', length: 300, nullable: true })
  notes: string | null;

  /** Seña a cobrar, en centavos (0 = sin seña). */
  @Column({ name: 'deposit_cents', type: 'int', default: 0 })
  depositCents: number;

  /** Hasta cuándo se retiene la mesa esperando el pago (solo en PENDING_PAYMENT). */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'cancelled_by', type: 'varchar', nullable: true })
  cancelledBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
