import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OutboxService } from '../messaging/outbox.service';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { BookingPolicy } from './booking-policy';
import { ReservationExpiredData, ReservationEvents } from './reservation-events';

/**
 * Libera las mesas de las reservas que no se pagaron a tiempo.
 *
 * Cada EXPIRATION_CHECK_MS busca las PENDING_PAYMENT con expiresAt vencido y las pasa a EXPIRED, emitiendo
 * `reservation.expired` en la misma transacción. Es un solo UPDATE ... RETURNING: si hay varias instancias del
 * servicio, la base garantiza que cada reserva la vence una sola (la segunda instancia ya no la ve pendiente).
 */
@Injectable()
export class ReservationExpirationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReservationExpirationService.name);
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly policy: BookingPolicy,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get<string>('EXPIRATION_CHECK_MS') ?? 30_000);
  }

  onModuleInit(): void {
    if (this.intervalMs > 0) this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Vence las reservas atrasadas. Devuelve los ids. Público para probarlo sin esperar al reloj. */
  async expireDue(): Promise<string[]> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(Reservation)
        .set({ status: ReservationStatus.EXPIRED })
        .where('status = :pending AND expires_at <= now()', { pending: ReservationStatus.PENDING_PAYMENT })
        // '*' y no una lista de columnas: con una lista TypeORM solo devolvía `id` (los eventos salían sin customerId)
        .returning('*')
        .execute();

      const rows = result.raw as Array<{
        id: string;
        customer_id: string;
        restaurant_id: string;
        restaurant_name: string | null;
        starts_at: Date | string;
        party_size: number;
      }>;
      for (const row of rows) {
        await this.outbox.enqueue(manager, ReservationEvents.EXPIRED, {
          reservationId: row.id,
          customerId: row.customer_id,
          restaurantId: row.restaurant_id,
          restaurantName: row.restaurant_name,
          startsAt: new Date(row.starts_at).toISOString(),
          partySize: row.party_size,
          timeZone: this.policy.timeZone,
        } satisfies ReservationExpiredData);
      }
      if (rows.length > 0) this.logger.log(`${rows.length} reserva(s) vencida(s) por falta de pago: ${rows.map((r) => r.id).join(', ')}`);
      return rows.map((row) => row.id);
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.expireDue()
        .catch((error: Error) => this.logger.error(`Falló el vencimiento de reservas: ${error.message}`))
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }
}
