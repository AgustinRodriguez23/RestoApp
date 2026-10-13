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

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'cancelled_by', type: 'varchar', nullable: true })
  cancelledBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
