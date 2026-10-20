import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventConsumers } from '../messaging/event-consumers.service';
import { EventEnvelope } from '../messaging/event-envelope';
import { buildNotification, NOTIFIABLE_EVENTS } from './notification-templates';
import { NotificationsService } from './notifications.service';

export const NOTIFICATIONS_CONSUMER = 'notifications-service.reservations';

/**
 * Escucha los eventos de las reservas y deja una notificación en la bandeja del cliente.
 * Es solo un consumidor: no publica nada ni toca a otros servicios, así que si este servicio está caído las reservas
 * siguen funcionando y los eventos esperan en la cola hasta que vuelva.
 */
@Injectable()
export class NotificationEventsConsumer implements OnModuleInit {
  /** Nombre de la cola. RABBITMQ_QUEUE_PREFIX permite aislar entornos que comparten broker (ej: tests). */
  readonly queueName: string;

  constructor(
    private readonly consumers: EventConsumers,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {
    this.queueName = `${config.get<string>('RABBITMQ_QUEUE_PREFIX') ?? ''}${NOTIFICATIONS_CONSUMER}`;
  }

  onModuleInit(): Promise<void> {
    return this.consumers.register({
      name: this.queueName,
      bindings: [...NOTIFIABLE_EVENTS],
      handler: (envelope) => this.handle(envelope),
      maxAttempts: 5,
      retryDelayMs: Number(this.config.get<string>('RABBITMQ_RETRY_DELAY_MS') ?? 5000),
    });
  }

  async handle(envelope: EventEnvelope): Promise<'processed' | 'duplicate'> {
    const draft = buildNotification(envelope); // lanza PoisonMessageError si el evento no sirve nunca
    if (!draft) return 'processed'; // nada que avisar (ej: la cancelación la hizo el propio cliente)
    const result = await this.notifications.createFromEvent(envelope.id, draft);
    return result === 'created' ? 'processed' : 'duplicate';
  }
}
