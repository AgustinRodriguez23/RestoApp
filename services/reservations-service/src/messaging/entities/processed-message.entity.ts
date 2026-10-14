import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Registro de mensajes ya procesados, para que un mensaje duplicado no tenga efecto dos veces.
 * La clave es (consumidor, id del mensaje): dos consumidores distintos pueden procesar el mismo
 * mensaje, pero cada uno solo una vez. Se inserta en la MISMA transacción que el efecto del handler.
 */
@Entity('processed_messages')
export class ProcessedMessage {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  consumer: string;

  @PrimaryColumn({ name: 'message_id', type: 'uuid' })
  messageId: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
