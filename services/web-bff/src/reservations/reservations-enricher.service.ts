import { Injectable } from '@nestjs/common';
import { settle } from '../common/settle';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';

/** Lo mínimo del restaurante que se muestra junto a cada reserva. */
export interface RestaurantSummary {
  id: string;
  name: string;
}

export type WithRestaurant<T> = T & { restaurant: RestaurantSummary | null };

interface HasRestaurantId {
  restaurantId: string;
}

/** Lo que aceptan como máximo los pedidos por lote de restaurants y payments: una página entera de "Mis reservas". */
const MAX_IDS = 50;

/** Parte una lista en tandas de MAX_IDS (con la página de "Mis reservas", que es de 50, siempre hay una sola). */
function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_IDS) result.push(items.slice(i, i + MAX_IDS));
  return result;
}

/**
 * Una reserva solo guarda el `restaurantId`. Para mostrar "Reserva en La Parrilla" se piden todos los restaurantes
 * de la lista en UN pedido (`GET /restaurants?ids=…`), no uno por restaurante.
 *
 * El nombre es un adorno: si no se puede obtener, la reserva se devuelve igual con `restaurant: null`.
 */
@Injectable()
export class ReservationsEnricher {
  constructor(private readonly upstream: UpstreamClient) {}

  async attachRestaurants<T extends HasRestaurantId>(reservations: T[], ctx: CallContext): Promise<WithRestaurant<T>[]> {
    const ids = [...new Set(reservations.map((r) => r.restaurantId))];
    const found = new Map<string, RestaurantSummary>();

    const results = await Promise.all(
      batches(ids).map((chunk) =>
        settle(
          this.upstream.call<{ data: Array<{ id: string; name: string }> }>(
            'restaurants',
            { path: '/restaurants', query: { ids: chunk.join(','), limit: chunk.length } },
            ctx,
          ),
        ),
      ),
    );
    for (const result of results) {
      if (!result.ok) continue;
      for (const r of result.value.data ?? []) {
        if (typeof r.name === 'string') found.set(r.id, { id: r.id, name: r.name });
      }
    }

    return reservations.map((r) => ({ ...r, restaurant: found.get(r.restaurantId) ?? null }));
  }
}

/** Estado del pago de una reserva, tal cual lo informa payments-service. */
export interface PaymentSummary {
  id: string;
  reservationId: string;
  status: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
  failureReason: string | null;
}

export type WithPayment<T> = T & { payment: PaymentSummary | null };

interface MaybeDeposit {
  id: string;
  depositCents?: number;
}

/**
 * Suma a cada reserva con seña el estado de su pago, para que la pantalla muestre "Pagar ahora" o
 * "Pago rechazado" sin pedirlo aparte. Todos en UN pedido (`GET /payments?reservationIds=…`): antes era uno por
 * reserva, y una página de 50 reservas eran 50 llamadas.
 *
 * Es un adorno: si payments-service no responde (o el pago todavía no se creó, porque se genera de forma asíncrona
 * al reservar), la reserva sale igual con `payment: null`.
 */
@Injectable()
export class PaymentsEnricher {
  constructor(private readonly upstream: UpstreamClient) {}

  async attachPayments<T extends MaybeDeposit>(reservations: T[], ctx: CallContext): Promise<WithPayment<T>[]> {
    const ids = reservations.filter((r) => (r.depositCents ?? 0) > 0).map((r) => r.id);
    const found = new Map<string, PaymentSummary>();

    const results = await Promise.all(
      batches(ids).map((chunk) =>
        settle(this.upstream.call<PaymentSummary[]>('payments', { path: '/payments', query: { reservationIds: chunk.join(',') } }, ctx)),
      ),
    );
    for (const result of results) {
      if (!result.ok) continue;
      for (const payment of result.value ?? []) found.set(payment.reservationId, payment);
    }

    return reservations.map((r) => ({ ...r, payment: found.get(r.id) ?? null }));
  }
}
