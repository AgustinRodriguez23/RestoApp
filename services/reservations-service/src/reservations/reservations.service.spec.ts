import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import { OutboxService } from '../messaging/outbox.service';
import { RestaurantInfo, RestaurantsClient } from '../restaurants-client/restaurants-client.service';
import { JwtPayload } from '../security/jwt-payload';
import { Role } from '../security/role.enum';
import { BookingPolicy } from './booking-policy';
import { DepositPolicy } from './deposit-policy';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { Reservation } from './entities/reservation.entity';
import { ReservationStatus } from './entities/reservation-status.enum';
import { isExclusionViolation, ReservationsService } from './reservations.service';

const RID = '64b7f0c2a1b2c3d4e5f60718';
const RES_ID = '3f2b1c5e-8a41-4c0e-9d3a-7a1f2b6c9d10';
const { CONFIRMED, CANCELLED, COMPLETED, NO_SHOW, PENDING_PAYMENT, EXPIRED } = ReservationStatus;

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
  openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }], // viernes de 20:00 a 01:00
};

const customer: JwtPayload = { sub: 'cust-1', email: 'c@example.com', name: 'Ana Pérez', role: Role.CUSTOMER };
const stranger: JwtPayload = { sub: 'cust-2', email: 's@example.com', role: Role.CUSTOMER };
const owner: JwtPayload = { sub: 'owner-1', email: 'o@example.com', role: Role.RESTAURANT_OWNER };
const otherOwner: JwtPayload = { sub: 'owner-2', email: 'o2@example.com', role: Role.RESTAURANT_OWNER };

const FUTURE_START = new Date('2026-10-17T00:00:00Z'); // viernes 21:00 en Buenos Aires
const PAST_START = new Date('2026-10-10T00:00:00Z');

const reservation = (overrides: Partial<Reservation> = {}): Reservation =>
  ({
    id: RES_ID,
    restaurantId: RID,
    tableNumber: 2,
    customerId: 'cust-1',
    partySize: 3,
    startsAt: FUTURE_START,
    endsAt: new Date(FUTURE_START.getTime() + 90 * 60_000),
    status: CONFIRMED,
    depositCents: 0,
    expiresAt: null,
    notes: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  }) as Reservation;

const exclusionError = () =>
  new QueryFailedError('INSERT', [], Object.assign(new Error('conflicting key value'), { code: '23P01' }));

const dto = (overrides: Partial<CreateReservationDto> = {}): CreateReservationDto => ({
  restaurantId: RID,
  partySize: 3,
  startsAt: '2026-10-16T21:00:00-03:00', // viernes 21:00 hora de Buenos Aires
  ...overrides,
});

describe('ReservationsService', () => {
  let service: ReservationsService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
    update: jest.Mock;
    findAndCount: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let summaryRows: unknown[];
  let qb: Record<string, jest.Mock>;
  let restaurants: { getRestaurant: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let deposit: DepositPolicy;
  let transaction: jest.Mock;
  let txManager: { getRepository: () => unknown };

  /** Política de seña de los tests: 5000 centavos por persona, 24 h de corte de reembolso, 15 min para pagar. */
  const makeDeposit = (perPersonCents: number) =>
    new DepositPolicy({
      get: (name: string) =>
        ({ DEPOSIT_PER_PERSON_CENTS: String(perPersonCents), PAYMENT_WINDOW_MINUTES: '15', REFUND_CUTOFF_HOURS: '24' })[name],
    } as never);

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    repo = {
      create: jest.fn((data: Partial<Reservation>) => ({ ...data })),
      save: jest.fn(async (entity: Partial<Reservation>) => ({ id: RES_ID, ...entity })),
      findOneBy: jest.fn(),
      update: jest.fn(),
      findAndCount: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
    };
    // Query builder de mentira: cada método devuelve el mismo objeto (encadenable) y getRawMany entrega las filas del test
    summaryRows = [];
    qb = {} as Record<string, jest.Mock>;
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) qb[m] = jest.fn(() => qb);
    qb.getRawMany = jest.fn(async () => summaryRows);
    restaurants = { getRestaurant: jest.fn().mockResolvedValue(restaurant) };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    deposit = makeDeposit(0); // sin seña por defecto: es el comportamiento de antes de existir los pagos
    // Una "transacción" de mentira: ejecuta el callback con un manager que usa el mismo repo simulado
    txManager = { getRepository: () => repo };
    transaction = jest.fn(async (fn: (m: unknown) => unknown) => fn(txManager));

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: getRepositoryToken(Reservation), useValue: repo },
        { provide: RestaurantsClient, useValue: restaurants },
        { provide: BookingPolicy, useValue: policy },
        { provide: DepositPolicy, useFactory: () => deposit },
        { provide: DataSource, useValue: { transaction } },
        { provide: OutboxService, useValue: outbox },
      ],
    }).compile();
    service = moduleRef.get(ReservationsService);
  });

  describe('isExclusionViolation', () => {
    it('reconoce solo el error de PostgreSQL de restricción de exclusión', () => {
      expect(isExclusionViolation(exclusionError())).toBe(true);
      expect(
        isExclusionViolation(new QueryFailedError('INSERT', [], Object.assign(new Error('x'), { code: '23505' }))),
      ).toBe(false);
      expect(isExclusionViolation(new Error('x'))).toBe(false);
      expect(isExclusionViolation(undefined)).toBe(false);
    });
  });

  describe('create', () => {
    it('asigna la mesa más chica en la que entra el grupo', async () => {
      await service.create(customer, dto({ partySize: 3 })); // mesas de 4: la 2 y la 3 → elige la 2

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurantId: RID,
          tableNumber: 2,
          customerId: 'cust-1',
          partySize: 3,
          status: CONFIRMED,
          notes: null,
        }),
      );
    });

    it('un grupo chico va a la mesa chica', async () => {
      await service.create(customer, dto({ partySize: 2 }));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ tableNumber: 1 }));
    });

    it('guarda el inicio y el fin (inicio + duración) como instantes exactos', async () => {
      await service.create(customer, dto());

      const data = repo.create.mock.calls[0][0];
      expect(data.startsAt.toISOString()).toBe('2026-10-17T00:00:00.000Z'); // 21:00 BA
      expect(data.endsAt.toISOString()).toBe('2026-10-17T01:30:00.000Z');
    });

    it('el cliente es siempre el usuario del token, y las notas se guardan', async () => {
      await service.create(stranger, dto({ notes: 'Cumpleaños' }));

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-2', notes: 'Cumpleaños' }));
    });

    it('guarda el nombre del cliente tomado del token', async () => {
      await service.create(customer, dto());
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ customerName: 'Ana Pérez' }));
    });

    it('guarda null si el token es viejo y no trae nombre', async () => {
      await service.create(stranger, dto());
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ customerName: null }));
    });

    it('si la mesa elegida está ocupada, prueba con la siguiente que sirva', async () => {
      repo.save
        .mockRejectedValueOnce(exclusionError())
        .mockImplementationOnce(async (entity: Partial<Reservation>) => ({ id: RES_ID, ...entity }));

      const result = await service.create(customer, dto({ partySize: 3 }));

      expect(repo.save).toHaveBeenCalledTimes(2);
      expect(repo.create.mock.calls.map(([data]) => data.tableNumber)).toEqual([2, 3]);
      expect(result.tableNumber).toBe(3);
    });

    it('si todas las mesas aptas están ocupadas responde 409', async () => {
      repo.save.mockRejectedValue(exclusionError());

      await expect(service.create(customer, dto({ partySize: 3 }))).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).toHaveBeenCalledTimes(3); // mesas 2, 3 y 4
    });

    it('un error de base de datos que NO es de solapamiento se propaga enseguida (no se confunde con "ocupada")', async () => {
      repo.save.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(customer, dto())).rejects.toThrow('connection lost');
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('rechaza un grupo para el que no hay mesa lo bastante grande', async () => {
      await expect(service.create(customer, dto({ partySize: 9 }))).rejects.toThrow(/no tiene mesas para 9/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rechaza una fecha pasada sin siquiera consultar a restaurants-service', async () => {
      await expect(
        service.create(customer, dto({ startsAt: '2026-10-09T21:00:00-03:00' })),
      ).rejects.toThrow(/a futuro/);
      expect(restaurants.getRestaurant).not.toHaveBeenCalled();
    });

    it('rechaza reservar con más anticipación que el máximo', async () => {
      await expect(
        service.create(customer, dto({ startsAt: '2027-03-05T21:00:00-03:00' })),
      ).rejects.toThrow(/90 días/);
    });

    it.each([
      ['minutos que no son múltiplo de 30', '2026-10-16T21:15:00-03:00'],
      ['segundos', '2026-10-16T21:00:30-03:00'],
      ['milisegundos', '2026-10-16T21:00:00.500-03:00'],
    ])('rechaza un horario con %s', async (_label, startsAt) => {
      await expect(service.create(customer, dto({ startsAt }))).rejects.toThrow(/múltiplo de 30/);
      expect(restaurants.getRestaurant).not.toHaveBeenCalled();
    });

    it('rechaza una fecha que no se puede interpretar', async () => {
      await expect(service.create(customer, dto({ startsAt: 'mañana' }))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un horario en el que el restaurante no atiende', async () => {
      await expect(
        service.create(customer, dto({ startsAt: '2026-10-16T19:00:00-03:00' })), // viernes 19:00, abre 20:00
      ).rejects.toThrow(/no atiende/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rechaza un día en el que el restaurante está cerrado', async () => {
      await expect(
        service.create(customer, dto({ startsAt: '2026-10-15T21:00:00-03:00' })), // jueves
      ).rejects.toThrow(/no atiende/);
    });

    it('acepta la última hora posible: la reserva termina justo al cierre (que cruza la medianoche)', async () => {
      await expect(
        service.create(customer, dto({ startsAt: '2026-10-16T23:30:00-03:00' })), // termina 01:00
      ).resolves.toBeDefined();
    });

    it('...pero no una que se pase del cierre', async () => {
      await expect(
        service.create(customer, dto({ startsAt: '2026-10-17T00:00:00-03:00' })), // terminaría 01:30
      ).rejects.toThrow(/no atiende/);
    });

    it('interpreta el día en la zona del restaurante, no en UTC', async () => {
      // 2026-10-17T00:30Z ya es sábado en UTC, pero en Buenos Aires es viernes 21:30
      await expect(
        service.create(customer, dto({ startsAt: '2026-10-17T00:30:00Z' })),
      ).resolves.toBeDefined();
    });

    it('propaga el 404 si el restaurante no existe', async () => {
      restaurants.getRestaurant.mockRejectedValue(new NotFoundException('Restaurante no encontrado'));

      await expect(service.create(customer, dto())).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('create con seña', () => {
    beforeEach(async () => {
      deposit = makeDeposit(5000);
      // se vuelve a armar el servicio con la política con seña
      const moduleRef = await Test.createTestingModule({
        providers: [
          ReservationsService,
          { provide: getRepositoryToken(Reservation), useValue: repo },
          { provide: RestaurantsClient, useValue: restaurants },
          { provide: BookingPolicy, useValue: policy },
          { provide: DepositPolicy, useValue: deposit },
          { provide: DataSource, useValue: { transaction } },
          { provide: OutboxService, useValue: outbox },
        ],
      }).compile();
      service = moduleRef.get(ReservationsService);
    });

    it('nace PENDING_PAYMENT con la seña (por persona × comensales) y una hora límite para pagar', async () => {
      await service.create(customer, dto({ partySize: 3 }));

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PENDING_PAYMENT,
          depositCents: 15000,
          expiresAt: new Date(NOW.getTime() + 15 * 60_000),
        }),
      );
    });

    it('deja el evento reservation.created en el outbox, dentro de la misma transacción que la reserva', async () => {
      const result = await service.create(customer, dto({ partySize: 3 }));

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      const [manager, type, data] = outbox.enqueue.mock.calls[0];
      expect(manager).toBe(txManager); // el manager de LA transacción: si fuera otro, el evento no se revertiría junto con la reserva
      expect(type).toBe('reservation.created');
      expect(data).toEqual({
        reservationId: result.id,
        customerId: 'cust-1',
        restaurantId: RID,
        amountCents: 15000,
        currency: 'ARS',
        expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      });
    });

    it('si la mesa está ocupada, la reserva fallida no deja eventos y se reintenta con otra mesa', async () => {
      repo.save
        .mockRejectedValueOnce(exclusionError())
        .mockImplementationOnce(async (entity: Partial<Reservation>) => ({ id: RES_ID, ...entity }));

      await service.create(customer, dto({ partySize: 3 }));

      expect(transaction).toHaveBeenCalledTimes(2); // una transacción por mesa probada
      expect(outbox.enqueue).toHaveBeenCalledTimes(1); // el evento solo se encoló en la que funcionó
    });

    it('sin seña configurada, nace CONFIRMED y emite reservation.confirmed', async () => {
      deposit = makeDeposit(0);
      const moduleRef = await Test.createTestingModule({
        providers: [
          ReservationsService,
          { provide: getRepositoryToken(Reservation), useValue: repo },
          { provide: RestaurantsClient, useValue: restaurants },
          { provide: BookingPolicy, useValue: policy },
          { provide: DepositPolicy, useValue: deposit },
          { provide: DataSource, useValue: { transaction } },
          { provide: OutboxService, useValue: outbox },
        ],
      }).compile();

      await moduleRef.get(ReservationsService).create(customer, dto());

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: CONFIRMED, depositCents: 0, expiresAt: null }));
      expect(outbox.enqueue.mock.calls[0][1]).toBe('reservation.confirmed');
    });
  });

  describe('findOne', () => {
    it('quien hizo la reserva la puede ver, sin consultar a restaurants-service', async () => {
      repo.findOneBy.mockResolvedValue(reservation());

      await expect(service.findOne(RES_ID, customer)).resolves.toMatchObject({ id: RES_ID });
      expect(restaurants.getRestaurant).not.toHaveBeenCalled();
    });

    it('el dueño del restaurante la puede ver', async () => {
      repo.findOneBy.mockResolvedValue(reservation());

      await expect(service.findOne(RES_ID, owner)).resolves.toMatchObject({ id: RES_ID });
    });

    it('otro cliente recibe 404: no se revela que la reserva existe', async () => {
      repo.findOneBy.mockResolvedValue(reservation());

      await expect(service.findOne(RES_ID, stranger)).rejects.toBeInstanceOf(NotFoundException);
      expect(restaurants.getRestaurant).not.toHaveBeenCalled();
    });

    it('el dueño de OTRO restaurante también recibe 404', async () => {
      repo.findOneBy.mockResolvedValue(reservation());

      await expect(service.findOne(RES_ID, otherOwner)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('si no existe responde 404', async () => {
      repo.findOneBy.mockResolvedValue(null);

      await expect(service.findOne(RES_ID, customer)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel', () => {
    const cancelled = reservation({ status: CANCELLED });

    it('quien reservó puede cancelar: queda registrado quién y cuándo', async () => {
      repo.findOneBy.mockResolvedValueOnce(reservation()).mockResolvedValueOnce(cancelled);
      repo.update.mockResolvedValue({ affected: 1 });

      const result = await service.cancel(RES_ID, customer);

      expect(repo.update).toHaveBeenCalledWith(
        { id: RES_ID, status: CONFIRMED },
        expect.objectContaining({ status: CANCELLED, cancelledBy: 'cust-1', cancelledAt: NOW }),
      );
      expect(result.status).toBe(CANCELLED);
    });

    it('emite reservation.cancelled en la misma transacción que el cambio de estado', async () => {
      repo.findOneBy.mockResolvedValueOnce(reservation({ depositCents: 15000 })).mockResolvedValueOnce(cancelled);
      repo.update.mockResolvedValue({ affected: 1 });

      await service.cancel(RES_ID, customer);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue.mock.calls[0][0]).toBe(txManager);
      expect(outbox.enqueue).toHaveBeenCalledWith(expect.anything(), 'reservation.cancelled', {
        reservationId: RES_ID,
        customerId: 'cust-1',
        restaurantId: RID,
        reason: 'CANCELLED_BY_CUSTOMER',
        refundable: true, // faltan más de 24 h
        depositCents: 15000,
      });
    });

    it('cancelar con menos de 24 h de anticipación NO es reembolsable', async () => {
      const soon = new Date(NOW.getTime() + 5 * 3_600_000);
      repo.findOneBy.mockResolvedValueOnce(reservation({ startsAt: soon })).mockResolvedValueOnce(cancelled);
      repo.update.mockResolvedValue({ affected: 1 });

      await service.cancel(RES_ID, customer);

      expect(outbox.enqueue.mock.calls[0][2]).toMatchObject({ refundable: false });
    });

    it('si cancela el dueño, la seña siempre se devuelve (aunque falten pocas horas)', async () => {
      const soon = new Date(NOW.getTime() + 2 * 3_600_000);
      repo.findOneBy.mockResolvedValueOnce(reservation({ startsAt: soon })).mockResolvedValueOnce(cancelled);
      repo.update.mockResolvedValue({ affected: 1 });

      await service.cancel(RES_ID, owner);

      expect(outbox.enqueue.mock.calls[0][2]).toMatchObject({ reason: 'CANCELLED_BY_OWNER', refundable: true });
    });

    it('se puede cancelar una reserva que todavía espera el pago', async () => {
      repo.findOneBy.mockResolvedValueOnce(reservation({ status: PENDING_PAYMENT })).mockResolvedValueOnce(cancelled);
      repo.update.mockResolvedValue({ affected: 1 });

      await service.cancel(RES_ID, customer);

      expect(repo.update).toHaveBeenCalledWith({ id: RES_ID, status: PENDING_PAYMENT }, expect.objectContaining({ status: CANCELLED, expiresAt: null }));
    });

    it('si el UPDATE condicional no toca nada (409), no se emite ningún evento', async () => {
      repo.findOneBy.mockResolvedValue(reservation());
      repo.update.mockResolvedValue({ affected: 0 });

      await expect(service.cancel(RES_ID, customer)).rejects.toThrow(/cambió de estado/);
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('el dueño del restaurante también puede cancelar', async () => {
      repo.findOneBy.mockResolvedValueOnce(reservation()).mockResolvedValueOnce(cancelled);
      repo.update.mockResolvedValue({ affected: 1 });

      await service.cancel(RES_ID, owner);

      expect(repo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ cancelledBy: 'owner-1' }),
      );
    });

    it('un tercero no puede cancelar (404) y no se modifica nada', async () => {
      repo.findOneBy.mockResolvedValue(reservation());

      await expect(service.cancel(RES_ID, stranger)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([CANCELLED, EXPIRED, COMPLETED, NO_SHOW])('no se puede cancelar una reserva %s (409)', async (status) => {
      repo.findOneBy.mockResolvedValue(reservation({ status }));

      await expect(service.cancel(RES_ID, customer)).rejects.toBeInstanceOf(ConflictException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('no se puede cancelar una reserva que ya comenzó', async () => {
      repo.findOneBy.mockResolvedValue(reservation({ startsAt: PAST_START }));

      await expect(service.cancel(RES_ID, customer)).rejects.toThrow(/ya comenzó/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('si alguien cambió la reserva entre la lectura y la escritura, responde 409 en vez de pisar el cambio', async () => {
      repo.findOneBy.mockResolvedValue(reservation());
      repo.update.mockResolvedValue({ affected: 0 }); // el UPDATE condicional no encontró la fila en CONFIRMED

      await expect(service.cancel(RES_ID, customer)).rejects.toThrow(/cambió de estado/);
    });
  });

  describe('updateStatus', () => {
    const started = () => reservation({ startsAt: PAST_START });

    it.each([COMPLETED, NO_SHOW] as const)('el dueño puede marcar %s una reserva que ya empezó', async (status) => {
      repo.findOneBy.mockResolvedValueOnce(started()).mockResolvedValueOnce(reservation({ status }));
      repo.update.mockResolvedValue({ affected: 1 });

      const result = await service.updateStatus(RES_ID, owner, status);

      expect(repo.update).toHaveBeenCalledWith({ id: RES_ID, status: CONFIRMED }, { status });
      expect(result.status).toBe(status);
    });

    it('no se puede marcar una reserva que todavía no empezó', async () => {
      repo.findOneBy.mockResolvedValue(reservation()); // empieza en el futuro

      await expect(service.updateStatus(RES_ID, owner, COMPLETED)).rejects.toThrow(/ya comenzó/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('el cliente no puede marcarse a sí mismo como completado (404)', async () => {
      repo.findOneBy.mockResolvedValue(started());

      await expect(service.updateStatus(RES_ID, customer, COMPLETED)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('el dueño de otro restaurante tampoco puede (404)', async () => {
      repo.findOneBy.mockResolvedValue(started());

      await expect(service.updateStatus(RES_ID, otherOwner, COMPLETED)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('una reserva cancelada no puede pasar a completada (409)', async () => {
      repo.findOneBy.mockResolvedValue(reservation({ startsAt: PAST_START, status: CANCELLED }));

      await expect(service.updateStatus(RES_ID, owner, COMPLETED)).rejects.toBeInstanceOf(ConflictException);
    });

    it('si la reserva cambió en el medio, responde 409', async () => {
      repo.findOneBy.mockResolvedValue(started());
      repo.update.mockResolvedValue({ affected: 0 });

      await expect(service.updateStatus(RES_ID, owner, NO_SHOW)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('listMine', () => {
    it('lista solo las reservas del usuario, las más recientes primero, con paginación', async () => {
      repo.findAndCount.mockResolvedValue([[reservation()], 25]);

      const result = await service.listMine(customer, { page: 3, limit: 10 });

      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: { customerId: 'cust-1' },
        order: { startsAt: 'DESC' },
        skip: 20,
        take: 10,
      });
      expect(result).toMatchObject({ page: 3, limit: 10, total: 25, totalPages: 3 });
    });

    it('permite filtrar por estado', async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);

      await service.listMine(customer, { status: CANCELLED });

      expect(repo.findAndCount.mock.calls[0][0].where).toEqual({ customerId: 'cust-1', status: CANCELLED });
    });
  });

  describe('listForRestaurant', () => {
    it('solo el dueño de ese restaurante puede listar (si no, 404)', async () => {
      await expect(service.listForRestaurant(RID, otherOwner, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.listForRestaurant(RID, customer, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findAndCount).not.toHaveBeenCalled();
    });

    it('lista las reservas del restaurante en orden cronológico', async () => {
      repo.findAndCount.mockResolvedValue([[reservation()], 1]);

      await service.listForRestaurant(RID, owner, {});

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { restaurantId: RID }, order: { startsAt: 'ASC' } }),
      );
    });

    it('filtra por día usando la medianoche local del restaurante (no la de UTC)', async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);

      await service.listForRestaurant(RID, owner, { date: '2026-10-16' });

      const where = repo.findAndCount.mock.calls[0][0].where;
      const range = where.startsAt as FindOperator<Date>;
      const [from, to] = range.value as unknown as FindOperator<Date>[];
      expect(range.type).toBe('and');
      expect((from.value as Date).toISOString()).toBe('2026-10-16T03:00:00.000Z'); // 00:00 en Buenos Aires
      expect((to.value as Date).toISOString()).toBe('2026-10-17T03:00:00.000Z');
    });

    it('rechaza una fecha inexistente', async () => {
      await expect(service.listForRestaurant(RID, owner, { date: '2026-02-30' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('summaryForRestaurant', () => {
    it('solo el dueño de ese restaurante puede verlo (si no, 404) y no consulta la base', async () => {
      await expect(service.summaryForRestaurant(RID, otherOwner, '2026-10-16')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.summaryForRestaurant(RID, customer, '2026-10-16')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('devuelve todos los estados (en 0 los que no hay) y convierte el COUNT, que llega como texto', async () => {
      summaryRows = [
        { status: 'CONFIRMED', count: '7' },
        { status: 'NO_SHOW', count: '2' },
      ];

      const result = await service.summaryForRestaurant(RID, owner, '2026-10-16');

      expect(result).toEqual({
        date: '2026-10-16',
        total: 9,
        byStatus: { PENDING_PAYMENT: 0, CONFIRMED: 7, CANCELLED: 0, EXPIRED: 0, COMPLETED: 0, NO_SHOW: 2 },
      });
    });

    it('un día sin reservas da todo en 0', async () => {
      const result = await service.summaryForRestaurant(RID, owner, '2026-10-16');
      expect(result.total).toBe(0);
      expect(Object.values(result.byStatus).every((n) => n === 0)).toBe(true);
    });

    it('cuenta el día calendario del restaurante (medianoche de Buenos Aires, no la de UTC) y solo ese restaurante', async () => {
      await service.summaryForRestaurant(RID, owner, '2026-10-16');

      const params = qb.andWhere.mock.calls[0][1] as { from: Date; to: Date };
      expect(params.from.toISOString()).toBe('2026-10-16T03:00:00.000Z');
      expect(params.to.toISOString()).toBe('2026-10-17T03:00:00.000Z');
      expect(qb.where).toHaveBeenCalledWith('r.restaurant_id = :restaurantId', { restaurantId: RID });
      expect(qb.groupBy).toHaveBeenCalledWith('r.status');
    });

    it('rechaza una fecha inexistente', async () => {
      await expect(service.summaryForRestaurant(RID, owner, '2026-02-30')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
