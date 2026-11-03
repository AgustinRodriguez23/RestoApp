import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

export enum OwnerRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * Pedido de un cliente para pasar a ser dueño de restaurante. Lo aprueba o rechaza un ADMIN.
 * Los datos del local son para evaluar el pedido: aprobarlo no crea el restaurante, eso lo hace el dueño desde su panel.
 */
@Entity('owner_requests')
// Una sola pendiente por usuario, y lo garantiza la base: con un "¿ya tiene una?" en el código, dos envíos
// simultáneos (doble click) pasarían los dos. Las revisadas no cuentan: después de un rechazo se puede pedir de nuevo.
@Index('UQ_owner_requests_pending_user', ['userId'], { unique: true, where: `"status" = 'PENDING'` })
// La consulta del admin: las de un estado, por fecha
@Index(['status', 'createdAt'])
export class OwnerRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  // Misma base que users, así que acá sí hay FK (entre servicios es solo una referencia lógica)
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ name: 'restaurant_name', type: 'varchar', length: 100 })
  restaurantName: string;

  @Column({ type: 'varchar', length: 200 })
  address: string;

  @Column({ type: 'varchar', length: 30 })
  phone: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  message: string | null;

  @Column({ type: 'enum', enum: OwnerRequestStatus, default: OwnerRequestStatus.PENDING })
  status: OwnerRequestStatus;

  @Column({ name: 'rejection_reason', type: 'varchar', length: 300, nullable: true })
  rejectionReason: string | null;

  /** El admin que la revisó */
  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
