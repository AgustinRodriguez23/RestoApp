import {
  Column,
  CreateDateColumn,
  Entity,
  Exclusion,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ReservationStatus } from './reservation-status.enum';

export const NO_OVERLAP_CONSTRAINT = 'reservations_no_overlap';

/**
 * La restricción de abajo garantiza que NUNCA haya dos reservas que retienen mesa solapadas en la misma mesa.
 *
 * Por qué en la base y no solo en el código: chequear "¿está libre?" y después insertar no es seguro cuando dos
 * requests llegan a la vez (las dos ven la mesa libre y las dos reservan). La base es el único lugar que puede
 * decidir con certeza, porque serializa las escrituras. El servicio solo intenta insertar y, si la base lo rechaza
 * (23P01), prueba con otra mesa.
 *
 * - EXCLUDE USING gist: no pueden existir dos filas con el mismo restaurante y mesa Y rangos de tiempo solapados.
 *   Comparar con "=" en un índice gist necesita la extensión btree_gist (la crea la migración inicial).
 * - tstzrange(starts_at, ends_at) es [inicio, fin): una reserva que termina a las 21:30 y otra que empieza a las
 *   21:30 NO se solapan.
 * - Solo CONFIRMED y PENDING_PAYMENT (esperando la seña) retienen la mesa; las canceladas, vencidas, completadas y
 *   ausentes no la bloquean.
 *
 * Tiene que estar declarada acá y no solo en la migración: al comparar las entidades con la base, TypeORM
 * borra las restricciones de exclusión que no conoce.
 */
@Entity('reservations')
@Exclusion(
  NO_OVERLAP_CONSTRAINT,
  `USING gist (restaurant_id WITH =, table_number WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('CONFIRMED', 'PENDING_PAYMENT'))`,
)
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
