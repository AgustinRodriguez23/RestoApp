import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Webhooks de la pasarela ya recibidos. Las pasarelas reenvían un webhook si no reciben 200 a tiempo,
 * así que el mismo evento puede llegar varias veces: el id del evento se guarda para aplicarlo una sola.
 */
@Entity('gateway_events')
export class GatewayEvent {
  @PrimaryColumn({ type: 'varchar', length: 30 })
  provider: string;

  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 100 })
  eventId: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;
}
