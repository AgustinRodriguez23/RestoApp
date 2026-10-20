import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  And,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { OutboxService } from '../messaging/outbox.service';
import { RestaurantsClient } from '../restaurants-client/restaurants-client.service';
import { fitsInShift } from '../scheduling/schedule';
import { localToUtc, parseDateOnly, utcToLocal } from '../scheduling/time-zone';
import { JwtPayload } from '../security/jwt-payload';
import { Role } from '../security/role.enum';
import { BookingPolicy } from './booking-policy';
import { DepositPolicy } from './deposit-policy';
import { ReservationCancelledData, ReservationConfirmedData, ReservationEvents, reservationDetails } from './reservation-events';
import { ListReservationsQueryDto, ListRestaurantReservationsQueryDto } from './dto/list-reservations-query.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { assertTransition } from './reservation-state';

export interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DaySummary {
  date: string;
  total: number;
  byStatus: Record<ReservationStatus, number>;
}

/** Código de PostgreSQL para "se violó una restricción de exclusión" (la de no solapar reservas). */
const EXCLUSION_VIOLATION = '23P01';

export function isExclusionViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === EXCLUSION_VIOLATION
  );
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @InjectRepository(Reservation) private readonly repo: Repository<Reservation>,
    private readonly restaurants: RestaurantsClient,
    private readonly policy: BookingPolicy,
    private readonly deposit: DepositPolicy,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Crea una reserva y le asigna la mesa más chica en la que entre el grupo.
   * No hay "chequear y después insertar": se intenta insertar directamente y es PostgreSQL
   * quien rechaza el solapamiento (ver ReservationsSchemaBootstrap). Si la mesa elegida
   * ya está tomada se prueba con la siguiente que sirva.
   */
  async create(user: JwtPayload, dto: CreateReservationDto): Promise<Reservation> {
    const startsAt = new Date(dto.startsAt);
    const local = this.validateStart(startsAt);

    const restaurant = await this.restaurants.getRestaurant(dto.restaurantId);

    if (!fitsInShift(restaurant.openingHours, local.dayOfWeek, local.minutesOfDay, this.policy.durationMinutes)) {
      throw new BadRequestException(
        'El restaurante no atiende en ese horario (la reserva completa tiene que entrar dentro de un turno)',
      );
    }

    const candidates = restaurant.tables
      .filter((table) => table.capacity >= dto.partySize)
      .sort((a, b) => a.capacity - b.capacity || a.number - b.number);
    if (candidates.length === 0) {
      throw new BadRequestException(`El restaurante no tiene mesas para ${dto.partySize} personas`);
    }

    const endsAt = new Date(startsAt.getTime() + this.policy.durationMinutes * MS_PER_MINUTE);

    // Con seña, la reserva queda PENDING_PAYMENT: retiene la mesa unos minutos mientras se paga.
    // Sin seña nace CONFIRMED, como siempre.
    const depositCents = this.deposit.amountFor(dto.partySize);
    const needsPayment = depositCents > 0;
    const expiresAt = needsPayment ? new Date(Date.now() + this.deposit.paymentWindowMinutes * MS_PER_MINUTE) : null;

    for (const table of candidates) {
      try {
        // La reserva y su evento se guardan en UNA transacción (outbox): o existen los dos o ninguno.
        // Cada mesa se prueba en su propia transacción porque una violación de la restricción aborta la anterior.
        const reservation = await this.dataSource.transaction(async (manager) => {
          const repo = manager.getRepository(Reservation);
          const saved = await repo.save(
            repo.create({
              restaurantId: dto.restaurantId,
              tableNumber: table.number,
              customerId: user.sub,
              customerName: user.name?.slice(0, 100) ?? null,
              restaurantName: restaurant.name ? restaurant.name.slice(0, 100) : null,
              partySize: dto.partySize,
              startsAt,
              endsAt,
              status: needsPayment ? ReservationStatus.PENDING_PAYMENT : ReservationStatus.CONFIRMED,
              depositCents,
              expiresAt,
              notes: dto.notes ?? null,
            }),
          );
          if (needsPayment) {
            await this.outbox.enqueue(manager, ReservationEvents.CREATED, {
              reservationId: saved.id,
              customerId: saved.customerId,
              restaurantId: saved.restaurantId,
              amountCents: depositCents,
              currency: this.deposit.currency,
              expiresAt: expiresAt?.toISOString(),
            });
          } else {
            await this.outbox.enqueue(manager, ReservationEvents.CONFIRMED, this.confirmedData(saved));
          }
          return saved;
        });
        this.logger.log(
          `Reserva ${reservation.id} creada (${reservation.status}, mesa ${table.number}, restaurante ${dto.restaurantId})`,
        );
        return reservation;
      } catch (error) {
        if (isExclusionViolation(error)) continue; // mesa ocupada en ese horario: probar la siguiente
        throw error;
      }
    }

    throw new ConflictException(
      'No hay mesas disponibles en ese horario. Consultá la disponibilidad y elegí otro.',
    );
  }

  async findOne(id: string, user: JwtPayload): Promise<Reservation> {
    return (await this.loadWithAccess(id, user)).reservation;
  }

  async listMine(user: JwtPayload, query: ListReservationsQueryDto): Promise<Paginated<Reservation>> {
    const where: FindOptionsWhere<Reservation> = { customerId: user.sub };
    if (query.status) where.status = query.status;

    return this.paginate(where, query, 'DESC');
  }

  async listForRestaurant(
    restaurantId: string,
    user: JwtPayload,
    query: ListRestaurantReservationsQueryDto,
  ): Promise<Paginated<Reservation>> {
    if (!(await this.isRestaurantOwner(restaurantId, user))) {
      throw new NotFoundException('Restaurante no encontrado');
    }

    const where: FindOptionsWhere<Reservation> = { restaurantId };
    if (query.status) where.status = query.status;
    if (query.date) {
      const { from, to } = this.dayRange(query.date);
      where.startsAt = And(MoreThanOrEqual(from), LessThan(to));
    }

    return this.paginate(where, query, 'ASC');
  }

  /**
   * Cuántas reservas hay en un día, por estado. Es una sola consulta agregada en la base (GROUP BY):
   * no trae las filas ni depende del tamaño de página, así que cuesta lo mismo con 10 reservas que con 1.000.
   * "Día" es el día calendario en la zona horaria del restaurante, igual que en el listado.
   */
  async summaryForRestaurant(restaurantId: string, user: JwtPayload, date: string): Promise<DaySummary> {
    if (!(await this.isRestaurantOwner(restaurantId, user))) {
      throw new NotFoundException('Restaurante no encontrado');
    }
    const range = this.dayRange(date);
    const rows = await this.repo
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('r.restaurant_id = :restaurantId', { restaurantId })
      .andWhere('r.starts_at >= :from AND r.starts_at < :to', { from: range.from, to: range.to })
      .groupBy('r.status')
      .getRawMany<{ status: ReservationStatus; count: string }>();

    // Todos los estados aparecen (en 0 si no hay): la pantalla no tiene que adivinar cuáles faltan
    const byStatus = Object.fromEntries(Object.values(ReservationStatus).map((s) => [s, 0])) as Record<ReservationStatus, number>;
    for (const row of rows) byStatus[row.status] = Number(row.count); // COUNT llega como texto (bigint)
    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
    return { date, total, byStatus };
  }

  /** Rango [inicio, fin) del día calendario `YYYY-MM-DD` en la zona horaria del restaurante. */
  private dayRange(dateText: string) {
    const date = parseDateOnly(dateText);
    if (!date) throw new BadRequestException('date no es una fecha válida (YYYY-MM-DD)');
    const from = localToUtc(date.year, date.month, date.day, 0, this.policy.timeZone);
    const to = localToUtc(date.year, date.month, date.day, 1440, this.policy.timeZone);
    return { from, to };
  }

  /**
   * La puede cancelar quien reservó o el dueño del restaurante, y solo antes de que empiece.
   * Si ya había una seña paga, el evento lleva `refundable`: lo decide ESTE servicio (es quien conoce la
   * política de cancelación) y payments-service solo ejecuta la devolución.
   */
  async cancel(id: string, user: JwtPayload): Promise<Reservation> {
    const { reservation } = await this.loadWithAccess(id, user);

    assertTransition(reservation.status, ReservationStatus.CANCELLED);
    if (reservation.startsAt.getTime() <= Date.now()) {
      throw new BadRequestException('No se puede cancelar una reserva que ya comenzó');
    }

    const byOwner = user.sub !== reservation.customerId;
    return this.applyTransition(
      reservation,
      ReservationStatus.CANCELLED,
      { cancelledAt: new Date(), cancelledBy: user.sub, expiresAt: null },
      (manager) =>
        this.outbox.enqueue(manager, ReservationEvents.CANCELLED, {
          reservationId: reservation.id,
          customerId: reservation.customerId,
          restaurantId: reservation.restaurantId,
          reason: byOwner ? 'CANCELLED_BY_OWNER' : 'CANCELLED_BY_CUSTOMER',
          refundable: this.deposit.isRefundable(reservation.startsAt, byOwner),
          depositCents: reservation.depositCents,
          ...reservationDetails(reservation, this.policy.timeZone),
        } satisfies ReservationCancelledData),
    );
  }

  /** Solo el dueño del restaurante marca si el cliente fue (COMPLETED) o no se presentó (NO_SHOW). */
  async updateStatus(
    id: string,
    user: JwtPayload,
    status: ReservationStatus.COMPLETED | ReservationStatus.NO_SHOW,
  ): Promise<Reservation> {
    const reservation = await this.findOrFail(id);
    if (!(await this.isRestaurantOwner(reservation.restaurantId, user))) {
      throw new NotFoundException('Reserva no encontrada');
    }

    assertTransition(reservation.status, status);
    if (reservation.startsAt.getTime() > Date.now()) {
      throw new BadRequestException('Solo se puede marcar como completada o ausente una reserva que ya comenzó');
    }

    return this.applyTransition(reservation, status);
  }

  // ---------------------------------------------------------------------------------------------

  /** Valida el inicio de la reserva y devuelve la hora local en el restaurante. */
  private validateStart(startsAt: Date) {
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('startsAt no es una fecha válida');
    }

    const now = Date.now();
    if (startsAt.getTime() <= now) {
      throw new BadRequestException('La reserva tiene que ser a futuro');
    }
    if (startsAt.getTime() > now + this.policy.maxAdvanceDays * MS_PER_DAY) {
      throw new BadRequestException(
        `Solo se puede reservar con hasta ${this.policy.maxAdvanceDays} días de anticipación`,
      );
    }

    const local = utcToLocal(startsAt, this.policy.timeZone);
    const step = this.policy.slotStepMinutes;
    if (local.second !== 0 || startsAt.getUTCMilliseconds() !== 0 || local.minutesOfDay % step !== 0) {
      throw new BadRequestException(`El horario tiene que ser múltiplo de ${step} minutos (por ejemplo 20:00 o 20:30)`);
    }
    return local;
  }

  private async findOrFail(id: string): Promise<Reservation> {
    const reservation = await this.repo.findOneBy({ id });
    if (!reservation) throw new NotFoundException('Reserva no encontrada');
    return reservation;
  }

  /**
   * Las reservas son privadas: las ve quien reservó y el dueño del restaurante. Para cualquier otra
   * persona la reserva "no existe" (404 en vez de 403), así no se revela qué ids existen.
   */
  private async loadWithAccess(id: string, user: JwtPayload): Promise<{ reservation: Reservation }> {
    const reservation = await this.findOrFail(id);

    if (reservation.customerId !== user.sub && !(await this.isRestaurantOwner(reservation.restaurantId, user))) {
      throw new NotFoundException('Reserva no encontrada');
    }
    return { reservation };
  }

  /** Dos chequeos: tener rol de dueño (barato, del token) y ser el dueño de ESE restaurante (consulta a restaurants). */
  private async isRestaurantOwner(restaurantId: string, user: JwtPayload): Promise<boolean> {
    if (user.role !== Role.RESTAURANT_OWNER) return false;
    const restaurant = await this.restaurants.getRestaurant(restaurantId);
    return restaurant.ownerId === user.sub;
  }

  /**
   * Cambia el estado solo si sigue siendo el que leímos (UPDATE ... WHERE id AND status = <el leído>).
   * Si entre la lectura y la escritura alguien más cambió la reserva (ej: la cancelan y la marcan
   * como completada a la vez), no se pisa su cambio: el segundo recibe un 409.
   * El evento (si hay) se deja en el outbox dentro de la misma transacción que el cambio.
   */
  private async applyTransition(
    reservation: Reservation,
    to: ReservationStatus,
    extra: Partial<Reservation> = {},
    event?: (manager: EntityManager) => Promise<unknown>,
  ): Promise<Reservation> {
    await this.dataSource.transaction(async (manager) => {
      const result = await manager
        .getRepository(Reservation)
        .update({ id: reservation.id, status: reservation.status }, { status: to, ...extra });
      if (!result.affected) {
        throw new ConflictException('La reserva cambió de estado mientras la procesábamos. Consultala de nuevo.');
      }
      await event?.(manager);
    });
    return this.findOrFail(reservation.id);
  }

  private confirmedData(reservation: Reservation): ReservationConfirmedData {
    return {
      reservationId: reservation.id,
      customerId: reservation.customerId,
      restaurantId: reservation.restaurantId,
      ...reservationDetails(reservation, this.policy.timeZone),
    };
  }

  private async paginate(
    where: FindOptionsWhere<Reservation>,
    query: ListReservationsQueryDto,
    direction: 'ASC' | 'DESC',
  ): Promise<Paginated<Reservation>> {
    const { page = 1, limit = 10 } = query;
    const [data, total] = await this.repo.findAndCount({
      where,
      order: { startsAt: direction },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
  }
}
