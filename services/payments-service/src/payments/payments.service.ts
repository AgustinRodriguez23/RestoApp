import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { PaymentEvents, ReservationCreatedData } from '../events/payment-events';
import { GatewayUnavailableError, PAYMENT_GATEWAY, PaymentGateway } from '../gateway/payment-gateway';
import { OutboxService } from '../messaging/outbox.service';
import { JwtPayload } from '../security/jwt-payload';
import { PaymentDto, toPaymentDto } from './dto/payment.dto';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { IdempotencyService } from './idempotency.service';
import { assertTransition } from './payment-state';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment) private readonly repo: Repository<Payment>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---------------------------------------------------------------- consultas (API)

  async findOne(id: string, user: JwtPayload): Promise<PaymentDto> {
    const payment = await this.repo.findOneBy({ id });
    return toPaymentDto(this.ownedOrNotFound(payment, user));
  }

  async findByReservation(reservationId: string, user: JwtPayload): Promise<PaymentDto> {
    const payment = await this.repo.findOneBy({ reservationId });
    return toPaymentDto(this.ownedOrNotFound(payment, user));
  }

  /**
   * Los pagos de varias reservas en una sola consulta (para "Mis reservas", que antes pedía uno por reserva).
   * Solo los del usuario: una reserva ajena o sin pago no aparece, igual que el 404 de findByReservation.
   */
  async findByReservations(reservationIds: string[], user: JwtPayload): Promise<PaymentDto[]> {
    const payments = await this.repo.findBy({ reservationId: In(reservationIds), customerId: user.sub });
    return payments.map(toPaymentDto);
  }

  // ---------------------------------------------------------------- cobro (API)

  /**
   * Cobra la seña. Con la misma Idempotency-Key repetida devuelve la misma respuesta sin cobrar de nuevo.
   *
   * Todo el cobro corre bajo un lock de la fila del pago (SELECT ... FOR UPDATE): dos pedidos simultáneos
   * para el mismo pago (aunque tengan claves distintas) se ejecutan uno después del otro, y el segundo
   * encuentra el pago ya resuelto y recibe 409. La pasarela además recibe una clave estable por pago, así
   * que aunque el proceso se cayera a mitad, el reintento no cobra dos veces.
   */
  pay(user: JwtPayload, paymentId: string, token: string, idempotencyKey: string) {
    return this.idempotency.run<PaymentDto>(user.sub, idempotencyKey, { paymentId, token }, async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({ where: { id: paymentId }, lock: { mode: 'pessimistic_write' } });
      this.ownedOrNotFound(payment, user);
      const locked = payment as Payment;

      if (locked.status !== PaymentStatus.PENDING) {
        throw new ConflictException(`Este pago no se puede cobrar: está ${locked.status}`);
      }
      if (locked.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException('Venció el plazo para pagar esta reserva');
      }

      let charge;
      try {
        charge = await this.gateway.createCharge({
          paymentId: locked.id,
          amountCents: locked.amountCents,
          currency: locked.currency,
          token,
          idempotencyKey: `pay-${locked.id}`,
        });
      } catch (error) {
        if (error instanceof GatewayUnavailableError) {
          this.logger.warn(`La pasarela no respondió para el pago ${locked.id}: ${error.message}`);
          // 502: no se cobró nada y el pago sigue PENDING. Se revierte la transacción, así la clave queda libre.
          throw new BadGatewayException('La pasarela de pagos no respondió. No se cobró nada: probá de nuevo.');
        }
        throw error;
      }

      locked.provider = this.gateway.name;
      locked.providerChargeId = charge.chargeId;

      if (charge.status === 'pending') {
        assertTransition(locked.status, PaymentStatus.PROCESSING);
        locked.status = PaymentStatus.PROCESSING;
        await repo.save(locked);
        this.logger.log(`Pago ${locked.id} en proceso: la pasarela avisará el resultado por webhook`);
        return { status: 202, body: toPaymentDto(locked) };
      }

      await this.settle(manager, locked, charge.status === 'succeeded' ? { ok: true } : { ok: false, reason: charge.reason });
      return { status: 200, body: toPaymentDto(locked) };
    });
  }

  // ---------------------------------------------------------------- usado por webhooks y consumidores

  /**
   * Registra el resultado del cobro (aprobado/rechazado) y avisa a reservations-service con un evento.
   * El `payment` tiene que estar bloqueado por quien llama, dentro de la transacción `manager`.
   */
  async settle(manager: EntityManager, payment: Payment, result: { ok: true } | { ok: false; reason: string }): Promise<void> {
    if (result.ok) {
      assertTransition(payment.status, PaymentStatus.SUCCEEDED);
      payment.status = PaymentStatus.SUCCEEDED;
      payment.paidAt = new Date();
      payment.failureReason = null;
      await manager.getRepository(Payment).save(payment);
      await this.outbox.enqueue(manager, PaymentEvents.SUCCEEDED, {
        paymentId: payment.id,
        reservationId: payment.reservationId,
        amountCents: payment.amountCents,
      });
      this.logger.log(`Pago ${payment.id} aprobado (reserva ${payment.reservationId})`);
    } else {
      assertTransition(payment.status, PaymentStatus.FAILED);
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = result.reason.slice(0, 200);
      await manager.getRepository(Payment).save(payment);
      await this.outbox.enqueue(manager, PaymentEvents.FAILED, {
        paymentId: payment.id,
        reservationId: payment.reservationId,
        reason: payment.failureReason,
      });
      this.logger.log(`Pago ${payment.id} rechazado (${result.reason})`);
    }
  }

  /**
   * Devuelve el dinero. Idempotente: si ya estaba devuelto no hace nada. La clave que recibe la pasarela es
   * estable por pago, así que un reintento tras un fallo no devuelve dos veces.
   * El `payment` tiene que estar bloqueado por quien llama.
   */
  async refund(manager: EntityManager, payment: Payment, reason: string): Promise<void> {
    if (payment.status === PaymentStatus.REFUNDED) return;
    assertTransition(payment.status, PaymentStatus.REFUNDED);
    if (!payment.providerChargeId) throw new Error(`El pago ${payment.id} no tiene cobro en la pasarela para devolver`);

    const { refundId } = await this.gateway.refund({
      chargeId: payment.providerChargeId,
      amountCents: payment.amountCents,
      idempotencyKey: `refund-${payment.id}`,
    });

    payment.status = PaymentStatus.REFUNDED;
    payment.providerRefundId = refundId;
    payment.refundedAt = new Date();
    await manager.getRepository(Payment).save(payment);
    await this.outbox.enqueue(manager, PaymentEvents.REFUNDED, {
      paymentId: payment.id,
      reservationId: payment.reservationId,
      amountCents: payment.amountCents,
      reason,
    });
    this.logger.log(`Pago ${payment.id} devuelto (${reason})`);
  }

  /** Crea el pago pendiente de una reserva. Idempotente: la reserva es única. */
  async createForReservation(manager: EntityManager, data: ReservationCreatedData): Promise<void> {
    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(Payment)
      .values({
        reservationId: data.reservationId,
        customerId: data.customerId,
        restaurantId: data.restaurantId,
        amountCents: data.amountCents,
        currency: data.currency,
        status: PaymentStatus.PENDING,
        expiresAt: new Date(data.expiresAt),
      })
      .orIgnore()
      .returning('id')
      .execute();
    if (inserted.raw.length > 0) {
      this.logger.log(`Pago ${inserted.raw[0].id} creado para la reserva ${data.reservationId} (${data.amountCents} ${data.currency})`);
    }
  }

  lockByReservation(manager: EntityManager, reservationId: string): Promise<Payment | null> {
    return manager.getRepository(Payment).findOne({ where: { reservationId }, lock: { mode: 'pessimistic_write' } });
  }

  lockById(manager: EntityManager, id: string): Promise<Payment | null> {
    return manager.getRepository(Payment).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  /** Para el que no es dueño, el pago "no existe" (404 y no 403: no se revela qué ids existen). */
  private ownedOrNotFound(payment: Payment | null, user: JwtPayload): Payment {
    if (!payment || payment.customerId !== user.sub) throw new NotFoundException('Pago no encontrado');
    return payment;
  }
}
