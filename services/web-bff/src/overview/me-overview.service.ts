import { Injectable } from '@nestjs/common';
import { settle, Warning } from '../common/settle';
import { ReservationsEnricher } from '../reservations/reservations-enricher.service';
import { CallContext, UpstreamClient } from '../upstream/upstream-client';

interface ReservationLite {
  restaurantId: string;
  startsAt: string;
}

const UPCOMING_LIMIT = 5;

/**
 * Pantalla de inicio del usuario: sus datos + sus próximas reservas, en una llamada.
 * El usuario es imprescindible (si auth-service falla, se propaga el error);
 * las reservas son un complemento (si fallan, `upcomingReservations` viene null con un aviso).
 */
@Injectable()
export class MeOverviewService {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly enricher: ReservationsEnricher,
  ) {}

  async getOverview(ctx: CallContext, now = new Date()) {
    const [user, reservations] = await Promise.all([
      settle(this.upstream.call('auth', { path: '/auth/me' }, ctx)),
      // reservations-service ordena de más nueva a más vieja, así que se trae un lote de confirmadas
      // y las "próximas" se arman acá
      settle(
        this.upstream.call<{ data: ReservationLite[] }>(
          'reservations',
          { path: '/reservations/mine', query: { status: 'CONFIRMED', limit: 50 } },
          ctx,
        ),
      ),
    ]);

    if (!user.ok) throw user.error;

    const warnings: Warning[] = [];
    let upcomingReservations = null;
    if (reservations.ok) {
      const upcoming = reservations.value.data
        .filter((r) => new Date(r.startsAt).getTime() > now.getTime())
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
        .slice(0, UPCOMING_LIMIT);
      upcomingReservations = await this.enricher.attachRestaurants(upcoming, ctx);
    } else {
      warnings.push({ section: 'upcomingReservations', message: 'No pudimos cargar tus reservas' });
    }

    return { user: user.value, upcomingReservations, warnings };
  }
}
