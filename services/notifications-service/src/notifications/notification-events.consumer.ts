import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventConsumers } from '../messaging/event-consumers.service';
import { EventEnvelope } from '../messaging/event-envelope';
import { buildNotification, NOTIFIABLE_EVENTS, OWNER_REQUEST_EVENTS } from './notification-templates';
import { NotificationsService } from './notifications.service';

export const NOTIFICATIONS_CONSUMER = 'notifications-service.reservations';
export const OWNER_REQUESTS_CONSUMER = 'notifications-service.owner-requests';

/**
 * Escucha los eventos de las reservas y de las solicitudes para ser dueño, y deja una notificación en la bandeja de
 * la persona. Es solo un consumidor: no publica nada ni toca a otros servicios, así que si este servicio está caído
 * el resto sigue funcionando y los eventos esperan en la cola hasta que vuelva.
 *
 * Una cola por origen, con el mismo handler: cada una tiene sus reintentos y su DLQ, así que un evento roto de auth no
 * se mezcla con los de reservas al inspeccionarlo.
 */
@Injectable()
export class NotificationEventsConsumer implements OnModuleInit {
  /** Nombres de las colas. RABBITMQ_QUEUE_PREFIX permite aislar entornos que comparten broker (ej: tests). */
  readonly queueName: string;
  readonly ownerRequestsQueueName: string;

  constructor(
    private readonly consumers: EventConsumers,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    const prefix = config.get<string>('RABBITMQ_QUEUE_PREFIX') ?? '';
    this.queueName = `${prefix}${NOTIFICATIONS_CONSUMER}`;
    this.ownerRequestsQueueName = `${prefix}${OWNER_REQUESTS_CONSUMER}`;
  }

  async onModuleInit(): Promise<void> {
    const common = {
      handler: (envelope: EventEnvelope) => this.handle(envelope),
      maxAttempts: 5,
      retryDelayMs: Number(this.config.get<string>('RABBITMQ_RETRY_DELAY_MS') ?? 5000),
    };
    await this.consumers.register({ ...common, name: this.queueName, bindings: [...NOTIFIABLE_EVENTS] });
    await this.consumers.register({ ...common, name: this.ownerRequestsQueueName, bindings: [...OWNER_REQUEST_EVENTS] });
  }

  async handle(envelope: EventEnvelope): Promise<'processed' | 'duplicate'> {
    const draft = buildNotification(envelope); // lanza PoisonMessageError si el evento no sirve nunca
    if (!draft) return 'processed'; // nada que avisar (ej: la cancelación la hizo el propio cliente)
    const result = await this.notifications.createFromEvent(envelope.id, draft);
    return result === 'created' ? 'processed' : 'duplicate';
  }
}
