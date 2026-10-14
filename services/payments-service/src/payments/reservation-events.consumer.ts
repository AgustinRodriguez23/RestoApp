import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import {
  RefundRequestedData,
  ReservationCancelledData,
  ReservationCreatedData,
  ReservationEvents,
  ReservationExpiredData,
} from '../events/payment-events';
import { EventConsumers } from '../messaging/event-consumers.service';
import { EventEnvelope, PoisonMessageError } from '../messaging/event-envelope';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { assertTransition } from './payment-state';
import { PaymentsService } from './payments.service';

export const RESERVATION_CONSUMER = 'payments-service.reservations';

/**
 * Reacciona a lo que pasa con las reservas. Cada handler corre dentro de la transacción de EventConsumers
 * (que también registra el mensaje como procesado): si algo falla se revierte todo y el mensaje se reintenta.
 *
 * Los mensajes pueden llegar fuera de orden (los reintentos reordenan). Por eso, si llega un evento sobre una
 * reserva cuyo pago todavía no existe, se lanza un error común (no "veneno"): se reintenta con demora, dando
 * tiempo a que llegue `reservation.created`; si nunca llega, termina en la DLQ para revisarlo.
 */
@Injectable()
export class ReservationEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(ReservationEventsConsumer.name);
  readonly queueName: string;

  constructor(
    private readonly consumers: EventConsumers,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {
    this.queueName = `${config.get<string>('RABBITMQ_QUEUE_PREFIX') ?? ''}${RESERVATION_CONSUMER}`;
  }

  onModuleInit(): Promise<void> {
    return this.consumers.register({
      name: this.queueName,
      bindings: [ReservationEvents.CREATED, ReservationEvents.CANCELLED, ReservationEvents.EXPIRED, ReservationEvents.REFUND_REQUESTED],
      handler: (envelope, manager) => this.handle(envelope, manager),
      maxAttempts: 5,
      retryDelayMs: Number(this.config.get<string>('RABBITMQ_RETRY_DELAY_MS') ?? 5000),
    });
  }

  async handle(envelope: EventEnvelope, manager: EntityManager): Promise<void> {
    switch (envelope.type) {
      case ReservationEvents.CREATED:
        return this.payments.createForReservation(manager, envelope.data as ReservationCreatedData);
      case ReservationEvents.EXPIRED:
        return this.onExpired(envelope.data as ReservationExpiredData, manager);
      case ReservationEvents.CANCELLED:
        return this.onCancelled(envelope.data as ReservationCancelledData, manager);
      case ReservationEvents.REFUND_REQUESTED:
        return this.onRefundRequested(envelope.data as RefundRequestedData, manager);
      default:
        throw new PoisonMessageError(`tipo de evento no soportado: ${envelope.type}`);
    }
  }

  /** La reserva venció sin pagarse: el pago pendiente se anula. */
  private async onExpired(data: ReservationExpiredData, manager: EntityManager): Promise<void> {
    const payment = await this.requirePayment(manager, data.reservationId);
    await this.closeIfPending(manager, payment, PaymentStatus.EXPIRED);
  }

  private async onCancelled(data: ReservationCancelledData, manager: EntityManager): Promise<void> {
    if (!data.depositCents) return; // la reserva no tenía seña: no hay pago

    const payment = await this.requirePayment(manager, data.reservationId);
    switch (payment.status) {
      case PaymentStatus.PENDING:
        return this.closeIfPending(manager, payment, PaymentStatus.CANCELLED);
      case PaymentStatus.SUCCEEDED:
        if (data.refundable) return this.payments.refund(manager, payment, data.reason);
        this.logger.log(`Reserva ${data.reservationId} cancelada fuera de plazo: la seña del pago ${payment.id} no se devuelve`);
        return;
      default:
        // PROCESSING: se resuelve cuando llegue el webhook (y si se aprobó, reservations pide la devolución).
        // FAILED / EXPIRED / CANCELLED / REFUNDED: nada que hacer.
        this.logger.log(`Reserva ${data.reservationId} cancelada con el pago ${payment.id} en ${payment.status}: sin acción`);
    }
  }

  /** reservations-service avisa que cobró una seña de una reserva que ya no existe: se devuelve. */
  private async onRefundRequested(data: RefundRequestedData, manager: EntityManager): Promise<void> {
    const payment = await this.payments.lockById(manager, data.paymentId);
    if (!payment) throw new PoisonMessageError(`el pago ${data.paymentId} no existe`);

    if (payment.status === PaymentStatus.REFUNDED) return;
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new Error(`el pago ${payment.id} está ${payment.status}: todavía no se puede devolver`);
    }
    await this.payments.refund(manager, payment, data.reason);
  }

  private async requirePayment(manager: EntityManager, reservationId: string): Promise<Payment> {
    const payment = await this.payments.lockByReservation(manager, reservationId);
    if (!payment) throw new Error(`todavía no existe el pago de la reserva ${reservationId}`);
    return payment;
  }

  private async closeIfPending(manager: EntityManager, payment: Payment, to: PaymentStatus.EXPIRED | PaymentStatus.CANCELLED) {
    if (payment.status !== PaymentStatus.PENDING) {
      this.logger.log(`Pago ${payment.id} está ${payment.status}: no se pasa a ${to}`);
      return;
    }
    assertTransition(payment.status, to);
    payment.status = to;
    await manager.getRepository(Payment).save(payment);
    this.logger.log(`Pago ${payment.id} pasó a ${to}`);
  }
}
