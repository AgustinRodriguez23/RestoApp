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

const MAX_PARALLEL = 10;

/**
 * Una reserva solo guarda el `restaurantId`. Para mostrar "Reserva en La Parrilla" el frontend
 * tendría que pedir cada restaurante aparte. Acá se hace una vez por restaurante distinto
 * (10 reservas en el mismo local = 1 consulta, no 10), con un máximo de consultas simultáneas
 * para no saturar restaurants-service.
 *
 * El nombre es un adorno: si no se puede obtener, la reserva se devuelve igual con `restaurant: null`.
 */
@Injectable()
export class ReservationsEnricher {
  constructor(private readonly upstream: UpstreamClient) {}

  async attachRestaurants<T extends HasRestaurantId>(reservations: T[], ctx: CallContext): Promise<WithRestaurant<T>[]> {
    const ids = [...new Set(reservations.map((r) => r.restaurantId))];
    const found = new Map<string, RestaurantSummary>();

    for (let i = 0; i < ids.length; i += MAX_PARALLEL) {
      const chunk = ids.slice(i, i + MAX_PARALLEL);
      const results = await Promise.all(
        chunk.map((id) => settle(this.upstream.call<{ id?: string; _id?: string; name: string }>('restaurants', { path: `/restaurants/${id}` }, ctx))),
      );
      results.forEach((result, index) => {
        if (result.ok && typeof result.value?.name === 'string') {
          found.set(chunk[index], { id: chunk[index], name: result.value.name });
        }
      });
    }

    return reservations.map((r) => ({ ...r, restaurant: found.get(r.restaurantId) ?? null }));
  }
}
