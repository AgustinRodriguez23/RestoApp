import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { FindOperator } from 'typeorm';
import { RestaurantInfo, RestaurantsClient } from '../restaurants-client/restaurants-client.service';
import { AvailabilityService } from './availability.service';
import { BookingPolicy } from './booking-policy';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';

const RID = '64b7f0c2a1b2c3d4e5f60718';

// Lunes 12 de octubre de 2026, 12:00 en Buenos Aires
const NOW = new Date('2026-10-12T15:00:00Z');

const policy = {
  durationMinutes: 90,
  slotStepMinutes: 30,
  maxAdvanceDays: 90,
  timeZone: 'America/Argentina/Buenos_Aires',
} as BookingPolicy;

const restaurant: RestaurantInfo = {
  id: RID,
  ownerId: 'owner-1',
  name: 'La Parrilla',
  tables: [
    { number: 1, capacity: 2 },
    { number: 2, capacity: 4 },
    { number: 3, capacity: 4 },
    { number: 4, capacity: 8 },
  ],
  openingHours: [
    { dayOfWeek: 5, opens: '20:00', closes: '01:00' }, // viernes de 20:00 a 01:00
    { dayOfWeek: 1, opens: '09:00', closes: '17:00' }, // lunes de 09:00 a 17:00
  ],
};

const busy = (tableNumber: number, startsAt: string, endsAt: string) =>
  ({ tableNumber, startsAt: new Date(startsAt), endsAt: new Date(endsAt) }) as Reservation;

describe('AvailabilityService', () => {
  let service: AvailabilityService;
  let repo: { find: jest.Mock };
  let restaurants: { getRestaurant: jest.Mock };

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    restaurants = { getRestaurant: jest.fn().mockResolvedValue(restaurant) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        { provide: getRepositoryToken(Reservation), useValue: repo },
        { provide: RestaurantsClient, useValue: restaurants },
        { provide: BookingPolicy, useValue: policy },
      ],
    }).compile();
    service = moduleRef.get(AvailabilityService);
  });

  const query = (overrides = {}) => ({ restaurantId: RID, date: '2026-10-16', partySize: 3, ...overrides });

  it('sin reservas, devuelve todos los horarios del turno con todas las mesas aptas libres', async () => {
    const result = await service.getAvailability(query());

    expect(result).toMatchObject({
      restaurantId: RID,
      date: '2026-10-16',
      partySize: 3,
      durationMinutes: 90,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(result.slots).toHaveLength(8);
    expect(result.slots[0]).toEqual({
      startsAt: '2026-10-16T23:00:00.000Z', // 20:00 en Buenos Aires
      endsAt: '2026-10-17T00:30:00.000Z',
      availableTables: 3, // mesas de 4, 4 y 8
    });
    expect(result.slots[7].startsAt).toBe('2026-10-17T02:30:00.000Z'); // 23:30, termina 01:00
  });

  it('cuenta solo las mesas en las que entra el grupo', async () => {
    const small = await service.getAvailability(query({ partySize: 2 }));
    const big = await service.getAvailability(query({ partySize: 6 }));

    expect(small.slots[0].availableTables).toBe(4);
    expect(big.slots[0].availableTables).toBe(1);
  });

  it('descuenta las mesas ocupadas solo en los horarios que realmente se solapan', async () => {
    repo.find.mockResolvedValue([
      busy(2, '2026-10-17T00:00:00Z', '2026-10-17T01:30:00Z'), // mesa 2: 21:00–22:30
      busy(3, '2026-10-17T01:30:00Z', '2026-10-17T03:00:00Z'), // mesa 3: 22:30–00:00
      busy(1, '2026-10-17T00:00:00Z', '2026-10-17T01:30:00Z'), // mesa 1 no es apta para 3: no cambia nada
    ]);

    const result = await service.getAvailability(query());

    // 20:00 20:30 21:00 21:30 22:00 22:30 23:00 23:30
    expect(result.slots.map((s) => s.availableTables)).toEqual([2, 2, 2, 1, 1, 2, 2, 2]);
  });

  it('las reservas pegadas (una termina cuando la otra empieza) no se pisan', async () => {
    repo.find.mockResolvedValue([busy(2, '2026-10-17T00:00:00Z', '2026-10-17T01:30:00Z')]); // 21:00–22:30

    const result = await service.getAvailability(query({ partySize: 3 }));
    const byStart = new Map(result.slots.map((s) => [s.startsAt, s.availableTables]));

    expect(byStart.get('2026-10-16T23:30:00.000Z')).toBe(2); // 20:30–22:00 se solapa
    expect(byStart.get('2026-10-17T01:30:00.000Z')).toBe(3); // 22:30–00:00 arranca justo cuando termina
  });

  it('un horario sin ninguna mesa libre no aparece', async () => {
    repo.find.mockResolvedValue([
      busy(2, '2026-10-17T00:00:00Z', '2026-10-17T01:30:00Z'),
      busy(3, '2026-10-17T00:00:00Z', '2026-10-17T01:30:00Z'),
      busy(4, '2026-10-17T00:00:00Z', '2026-10-17T01:30:00Z'),
    ]);

    const result = await service.getAvailability(query());
    const starts = result.slots.map((s) => s.startsAt);

    // Con las tres mesas aptas ocupadas 21:00–22:30, desaparecen los turnos de 20:00 a 22:00 (todos se solapan)
    expect(starts).toEqual([
      '2026-10-17T01:30:00.000Z', // 22:30
      '2026-10-17T02:00:00.000Z', // 23:00
      '2026-10-17T02:30:00.000Z', // 23:30
    ]);
  });

  it('busca solo reservas que ocupan mesa (confirmadas o esperando la seña) del restaurante, en una única consulta', async () => {
    await service.getAvailability(query());

    expect(repo.find).toHaveBeenCalledTimes(1);
    const { where } = repo.find.mock.calls[0][0];
    expect(where.restaurantId).toBe(RID);
    expect((where.status as FindOperator<ReservationStatus>).type).toBe('in');
    expect((where.status as FindOperator<ReservationStatus>).value).toEqual([
      ReservationStatus.CONFIRMED,
      ReservationStatus.PENDING_PAYMENT,
    ]);
    expect((where.startsAt as FindOperator<Date>).type).toBe('lessThan');
    expect((where.endsAt as FindOperator<Date>).type).toBe('moreThan');
  });

  it('el día de hoy no ofrece horarios que ya pasaron', async () => {
    // Lunes 12/10 a las 12:00: abre 09:00–17:00, así que quedan 12:30 … 15:30
    const result = await service.getAvailability(query({ date: '2026-10-12' }));

    expect(result.slots).toHaveLength(7);
    expect(result.slots[0].startsAt).toBe('2026-10-12T15:30:00.000Z'); // 12:30
    expect(result.slots[6].startsAt).toBe('2026-10-12T18:30:00.000Z'); // 15:30
  });

  it('un día pasado devuelve vacío sin consultar reservas', async () => {
    const result = await service.getAvailability(query({ date: '2026-10-05' })); // lunes anterior

    expect(result.slots).toEqual([]);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('un día más allá del máximo de anticipación devuelve vacío', async () => {
    const result = await service.getAvailability(query({ date: '2027-03-05' })); // viernes, 144 días

    expect(result.slots).toEqual([]);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('un día en que el restaurante cierra devuelve vacío', async () => {
    const result = await service.getAvailability(query({ date: '2026-10-15' })); // jueves

    expect(result.slots).toEqual([]);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('si ninguna mesa alcanza para el grupo devuelve vacío', async () => {
    const result = await service.getAvailability(query({ partySize: 9 }));

    expect(result.slots).toEqual([]);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('rechaza una fecha inexistente', async () => {
    await expect(service.getAvailability(query({ date: '2026-02-30' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(restaurants.getRestaurant).not.toHaveBeenCalled();
  });

  it('propaga el 404 si el restaurante no existe', async () => {
    restaurants.getRestaurant.mockRejectedValue(new NotFoundException());

    await expect(service.getAvailability(query())).rejects.toBeInstanceOf(NotFoundException);
  });
});
