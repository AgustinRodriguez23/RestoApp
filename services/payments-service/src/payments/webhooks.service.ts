import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GatewayWebhookEvent, PAYMENT_GATEWAY, PaymentGateway } from '../gateway/payment-gateway';
import { GatewayEvent } from './entities/gateway-event.entity';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from './entities/payment-status.enum';
import { PaymentsService } from './payments.service';

export type WebhookOutcome = 'applied' | 'duplicate' | 'already_settled';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /** Verifica la firma y aplica el resultado. Lanza InvalidWebhookError si no es auténtico. */
  handle(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
    const event = this.gateway.parseWebhook(rawBody, headers);
    return this.apply(event);
  }

  /**
   * En una sola transacción: registra el id del evento (para descartar repetidos) y aplica el resultado.
   * Si el cobro todavía no existe (el webhook llegó antes de que se confirmara el pedido de cobro) se responde
   * 404 y se revierte todo, incluido el registro del evento: la pasarela reintenta y esta vez lo encuentra.
   */
  private apply(event: GatewayWebhookEvent): Promise<WebhookOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(GatewayEvent)
        .values({ provider: this.gateway.name, eventId: event.eventId })
        .orIgnore()
        .returning('event_id')
        .execute();
      if (inserted.raw.length === 0) {
        this.logger.warn(`Webhook ${event.eventId} repetido: se ignora`);
        return 'duplicate';
      }

      const payment = await manager
        .getRepository(Payment)
        .findOne({ where: { providerChargeId: event.chargeId }, lock: { mode: 'pessimistic_write' } });
      if (!payment) throw new NotFoundException(`No hay un pago para el cobro ${event.chargeId}`);

      if (payment.status !== PaymentStatus.PROCESSING) {
        // Ya se resolvió por otro camino (o el webhook es viejo): el resultado ya está registrado
        this.logger.warn(`Webhook ${event.eventId} para el pago ${payment.id}, que ya está ${payment.status}: se ignora`);
        return 'already_settled';
      }

      await this.payments.settle(
        manager,
        payment,
        event.type === 'charge.succeeded' ? { ok: true } : { ok: false, reason: event.failureReason ?? 'declined' },
      );
      return 'applied';
    });
  }
}
