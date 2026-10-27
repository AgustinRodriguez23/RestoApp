import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

function nonNegativeInt(config: ConfigService, name: string, fallback: number): number {
  const raw = config.get<string | number>(name);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} tiene que ser un entero mayor o igual a 0 (valor recibido: "${raw}")`);
  }
  return value;
}

/** Reglas de la seña. Si algo está mal configurado, el servicio no arranca. */
@Injectable()
export class DepositPolicy {
  /** Seña por persona, en centavos. 0 = no se cobra seña (la reserva nace confirmada). */
  readonly perPersonCents: number;
  readonly currency: string;
  /** Cuánto tiempo se retiene la mesa esperando el pago. */
  readonly paymentWindowMinutes: number;
  /** Si el cliente cancela con menos de estas horas de anticipación, pierde la seña. */
  readonly refundCutoffHours: number;
  /** Cuántas reservas puede tener un cliente esperando el pago a la vez (cada una retiene una mesa sin pagar). */
  readonly maxPendingPerCustomer: number;

  constructor(config: ConfigService) {
    this.perPersonCents = nonNegativeInt(config, 'DEPOSIT_PER_PERSON_CENTS', 0);
    this.paymentWindowMinutes = nonNegativeInt(config, 'PAYMENT_WINDOW_MINUTES', 15);
    if (this.paymentWindowMinutes === 0) throw new Error('PAYMENT_WINDOW_MINUTES tiene que ser mayor a 0');
    this.maxPendingPerCustomer = nonNegativeInt(config, 'MAX_PENDING_RESERVATIONS', 3);
    if (this.maxPendingPerCustomer === 0) throw new Error('MAX_PENDING_RESERVATIONS tiene que ser mayor a 0');
    this.refundCutoffHours = nonNegativeInt(config, 'REFUND_CUTOFF_HOURS', 24);
    this.currency = config.get<string>('DEPOSIT_CURRENCY') || 'ARS';
  }

  amountFor(partySize: number): number {
    return this.perPersonCents * partySize;
  }

  /**
   * ¿Corresponde devolver la seña? El dueño que cancela devuelve siempre (el cliente no tiene la culpa);
   * si cancela el cliente, solo con la anticipación suficiente.
   */
  isRefundable(startsAt: Date, cancelledByOwner: boolean, now = new Date()): boolean {
    if (cancelledByOwner) return true;
    return startsAt.getTime() - now.getTime() >= this.refundCutoffHours * 3_600_000;
  }
}
