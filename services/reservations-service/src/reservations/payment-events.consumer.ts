import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { EventConsumers } from '../messaging/event-consumers.service';
import { EventEnvelope, PoisonMessageError } from '../messaging/event-envelope';
import { OutboxService } from '../messaging/outbox.service';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import {
  PaymentEvents,
  PaymentFailedData,
  PaymentSucceededData,
  RefundRequestedData,
  ReservationCancelledData,
  ReservationConfirmedData,
  ReservationEvents,
  reservationDetails,
} from './reservation-events';
import { BookingPolicy } from './booking-policy';

export const PAYMENT_CONSUMER = 'reservations-service.payments';

/**
 * Reacciona al resultado del cobro. Cada handler corre dentro de la transacción que arma EventConsumers
 * (que también registra el mensaje como procesado), así que el cambio de estado y los eventos que
 * emite se guardan juntos o no se guardan.
 *
 * Los cambios de estado son UPDATE condicionales (WHERE status = 'PENDING_PAYMENT'): si la reserva venció o
 * se canceló en el mismo instante, el UPDATE no toca nada y se resuelve de forma segura.
 */
@Injectable()
export class PaymentEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  /** Nombre de la cola. RABBITMQ_QUEUE_PREFIX permite aislar entornos que comparten broker (ej: tests). */
  readonly queueName: string;

  constructor(
    private readonly consumers: EventConsumers,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
    private readonly policy: BookingPolicy,
  ) {
    this.queueName = `${config.get<string>('RABBITMQ_QUEUE_PREFIX') ?? ''}${PAYMENT_CONSUMER}`;
  }

  onModuleInit(): Promise<void> {
    return this.consumers.register({
      name: this.queueName,
      bindings: [PaymentEvents.SUCCEEDED, PaymentEvents.FAILED],
      handler: (envelope, manager) => this.handle(envelope, manager),
      maxAttempts: 5,
      retryDelayMs: Number(this.config.get<string>('RABBITMQ_RETRY_DELAY_MS') ?? 5000),
    });
  }

  async handle(envelope: EventEnvelope, manager: EntityManager): Promise<void> {
    switch (envelope.type) {
      case PaymentEvents.SUCCEEDED:
        return this.onPaymentSucceeded(envelope.data as PaymentSucceededData, manager);
      case PaymentEvents.FAILED:
        return this.onPaymentFailed(envelope.data as PaymentFailedData, manager);
      default:
        throw new PoisonMessageError(`tipo de evento no soportado: ${envelope.type}`);
    }
  }

  private async onPaymentSucceeded(data: PaymentSucceededData, manager: EntityManager): Promise<void> {
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOneBy({ id: data.reservationId });
    if (!reservation) throw new PoisonMessageError(`la reserva ${data.reservationId} no existe`);

    if (reservation.status === ReservationStatus.CONFIRMED) return; // ya estaba confirmada

    if (reservation.status === ReservationStatus.PENDING_PAYMENT) {
      const result = await repo.update(
        { id: reservation.id, status: ReservationStatus.PENDING_PAYMENT },
        { status: ReservationStatus.CONFIRMED, expiresAt: null },
      );
      if (!result.affected) throw new Error('la reserva cambió de estado mientras se confirmaba; se reintenta');

      await this.outbox.enqueue(manager, ReservationEvents.CONFIRMED, {
        reservationId: reservation.id,
        customerId: reservation.customerId,
        restaurantId: reservation.restaurantId,
        ...reservationDetails(reservation, this.policy.timeZone),
      } satisfies ReservationConfirmedData);
      this.logger.log(`Reserva ${reservation.id} confirmada por el pago ${data.paymentId}`);
      return;
    }

    // El pago llegó tarde: la reserva ya venció o se canceló y la mesa quizá ya la tomó otra persona.
    // Compensación: se pide devolver el dinero.
    this.logger.warn(`Pago ${data.paymentId} aprobado pero la reserva ${reservation.id} está ${reservation.status}: se pide devolución`);
    await this.outbox.enqueue(manager, ReservationEvents.REFUND_REQUESTED, {
      reservationId: reservation.id,
      paymentId: data.paymentId,
      reason: `RESERVATION_${reservation.status}`,
    } satisfies RefundRequestedData);
  }

  private async onPaymentFailed(data: PaymentFailedData, manager: EntityManager): Promise<void> {
    const repo = manager.getRepository(Reservation);
    const reservation = await repo.findOneBy({ id: data.reservationId });
    if (!reservation) throw new PoisonMessageError(`la reserva ${data.reservationId} no existe`);

    if (reservation.status !== ReservationStatus.PENDING_PAYMENT) {
      this.logger.warn(`Pago ${data.paymentId} fallido ignorado: la reserva ${reservation.id} ya está ${reservation.status}`);
      return;
    }

    // Compensación: el cobro falló, se cancela la reserva y la mesa vuelve a estar libre
    const result = await repo.update(
      { id: reservation.id, status: ReservationStatus.PENDING_PAYMENT },
      { status: ReservationStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: 'system:payment-failed', expiresAt: null },
    );
    if (!result.affected) throw new Error('la reserva cambió de estado mientras se cancelaba; se reintenta');

    await this.outbox.enqueue(manager, ReservationEvents.CANCELLED, {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      restaurantId: reservation.restaurantId,
      reason: 'PAYMENT_FAILED',
      refundable: false,
      depositCents: reservation.depositCents,
      ...reservationDetails(reservation, this.policy.timeZone),
    } satisfies ReservationCancelledData);
    this.logger.log(`Reserva ${reservation.id} cancelada: el pago ${data.paymentId} falló (${data.reason})`);
  }
}
