import { BadRequestException, Injectable } from '@nestjs/common';
import { Settled, settle, Warning } from '../common/settle';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';
import { OverviewQueryDto } from './dto/restaurants.dto';

export interface RestaurantOverview {
  restaurant: unknown;
  menu: unknown[] | null;
  availability: unknown | null;
  warnings: Warning[];
}

/**
 * La razón de ser de un BFF: la pantalla de un restaurante necesita datos de DOS servicios
 * (restaurante+carta de restaurants-service, horarios libres de reservations-service).
 * Sin BFF el frontend haría 3 llamadas y manejaría 3 formas de fallar; acá se hacen EN PARALELO
 * y se devuelve un solo objeto.
 *
 * Qué es imprescindible y qué no: sin el restaurante no hay nada que mostrar, así que si falla
 * (o no existe) se propaga el error. La carta y la disponibilidad son complementos: si fallan,
 * se responde igual con `null` y un aviso en `warnings`, para que el frontend muestre el resto.
 */
@Injectable()
export class RestaurantsOverviewService {
  constructor(private readonly upstream: UpstreamClient) {}

  async getOverview(id: string, query: OverviewQueryDto, ctx: CallContext): Promise<RestaurantOverview> {
    if ((query.date === undefined) !== (query.partySize === undefined)) {
      throw new BadRequestException('date y partySize se indican juntos (o ninguno de los dos)');
    }

    const wantsAvailability = query.date !== undefined && query.partySize !== undefined;
    const [restaurant, menu, availability] = await Promise.all([
      settle(this.upstream.call('restaurants', { path: `/restaurants/${id}` }, ctx)),
      settle(this.upstream.call<unknown[]>('restaurants', { path: `/restaurants/${id}/menu` }, ctx)),
      wantsAvailability
        ? settle(
            this.upstream.call(
              'reservations',
              { path: '/availability', query: { restaurantId: id, date: query.date, partySize: query.partySize } },
              ctx,
            ),
          )
        : Promise.resolve(null),
    ]);

    if (!restaurant.ok) throw restaurant.error;

    const warnings: Warning[] = [];
    return {
      restaurant: restaurant.value,
      menu: this.optional(menu, 'menu', 'No pudimos cargar la carta', warnings),
      availability: availability === null ? null : this.optional(availability, 'availability', 'No pudimos consultar la disponibilidad', warnings),
      warnings,
    };
  }

  private optional<T>(result: Settled<T>, section: string, message: string, warnings: Warning[]): T | null {
    if (result.ok) return result.value;
    warnings.push({ section, message });
    return null;
  }
}
