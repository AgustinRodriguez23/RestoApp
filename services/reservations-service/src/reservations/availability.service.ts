import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Repository } from 'typeorm';
import { RestaurantsClient } from '../restaurants-client/restaurants-client.service';
import { generateSlotStarts } from '../scheduling/schedule';
import { dayOfWeekOf, localToUtc, parseDateOnly } from '../scheduling/time-zone';
import { BookingPolicy } from './booking-policy';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { Reservation } from './entities/reservation.entity';
import { BLOCKING_STATUSES } from './entities/reservation-status.enum';

export interface AvailabilitySlot {
  startsAt: string;
  endsAt: string;
  availableTables: number;
}

export interface AvailabilityResponse {
  restaurantId: string;
  date: string;
  partySize: number;
  durationMinutes: number;
  timeZone: string;
  slots: AvailabilitySlot[];
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(Reservation) private readonly repo: Repository<Reservation>,
    private readonly restaurants: RestaurantsClient,
    private readonly policy: BookingPolicy,
  ) {}

  /**
   * Horarios en los que se puede reservar un día para un grupo de N personas.
   *
   * Es una foto del momento: entre que se consulta y se reserva, otra persona puede tomar la mesa.
   * Por eso crear la reserva vuelve a validar y puede responder 409 aunque acá figurara libre.
   */
  async getAvailability(query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    const date = parseDateOnly(query.date);
    if (!date) throw new BadRequestException('date no es una fecha válida (YYYY-MM-DD)');

    const restaurant = await this.restaurants.getRestaurant(query.restaurantId);
    const base = {
      restaurantId: query.restaurantId,
      date: query.date,
      partySize: query.partySize,
      durationMinutes: this.policy.durationMinutes,
      timeZone: this.policy.timeZone,
    };

    const eligibleTables = restaurant.tables.filter((table) => table.capacity >= query.partySize);
    const startMinutes = generateSlotStarts(
      restaurant.openingHours,
      dayOfWeekOf(date),
      this.policy.durationMinutes,
      this.policy.slotStepMinutes,
    );
    if (eligibleTables.length === 0 || startMinutes.length === 0) return { ...base, slots: [] };

    const durationMs = this.policy.durationMinutes * MS_PER_MINUTE;
    const now = Date.now();
    const latest = now + this.policy.maxAdvanceDays * MS_PER_DAY;

    const candidates = startMinutes
      .map((minutes) => localToUtc(date.year, date.month, date.day, minutes, this.policy.timeZone))
      .filter((start) => start.getTime() > now && start.getTime() <= latest);
    if (candidates.length === 0) return { ...base, slots: [] };

    // Una sola consulta con todas las reservas confirmadas que tocan la ventana del día
    const windowStart = candidates[0];
    const windowEnd = new Date(candidates[candidates.length - 1].getTime() + durationMs);
    const busy = await this.repo.find({
      select: { tableNumber: true, startsAt: true, endsAt: true },
      where: {
        restaurantId: query.restaurantId,
        status: In([...BLOCKING_STATUSES]), // las que esperan la seña también retienen la mesa
        startsAt: LessThan(windowEnd),
        endsAt: MoreThan(windowStart),
      },
    });

    const slots: AvailabilitySlot[] = [];
    for (const start of candidates) {
      const end = new Date(start.getTime() + durationMs);
      const occupied = new Set(
        busy.filter((r) => r.startsAt < end && r.endsAt > start).map((r) => r.tableNumber),
      );
      const availableTables = eligibleTables.filter((table) => !occupied.has(table.number)).length;
      if (availableTables > 0) {
        slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString(), availableTables });
      }
    }
    return { ...base, slots };
  }
}
