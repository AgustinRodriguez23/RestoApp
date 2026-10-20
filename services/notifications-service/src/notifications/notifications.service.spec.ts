import { NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { NotificationDraft } from './notification-templates';
import { NotificationsService } from './notifications.service';
import { Notification } from './schemas/notification.schema';

const OID = '64b7f0c2a1b2c3d4e5f60718';

const draft: NotificationDraft = {
  userId: 'cust-1',
  type: 'RESERVATION_CONFIRMED',
  title: 'Reserva confirmada',
  body: 'Tu mesa está confirmada.',
  reservationId: 'res-1',
  restaurantId: 'rest-1',
};

/** Encadena sort/skip/limit como el Query de Mongoose y se resuelve con `result` al esperarlo. */
function query<T>(result: T) {
  const q: Record<string, jest.Mock> & PromiseLike<T> = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: (resolve: (v: T) => unknown) => Promise.resolve(result).then(resolve),
  } as never;
  return q;
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  const model = {
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    updateMany: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [NotificationsService, { provide: getModelToken(Notification.name), useValue: model }],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  describe('createFromEvent', () => {
    it('guarda la notificación con el id del evento y dice que la creó', async () => {
      model.create.mockResolvedValue({});
      await expect(service.createFromEvent('evt-1', draft)).resolves.toBe('created');
      expect(model.create).toHaveBeenCalledWith({ ...draft, eventId: 'evt-1' });
    });

    it('si el evento ya estaba (clave duplicada 11000), lo informa como duplicado en vez de fallar', async () => {
      model.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      await expect(service.createFromEvent('evt-1', draft)).resolves.toBe('duplicate');
    });

    it('cualquier otro error de la base se propaga (el mensaje se reintenta)', async () => {
      model.create.mockRejectedValue(new Error('connection lost'));
      await expect(service.createFromEvent('evt-1', draft)).rejects.toThrow('connection lost');
    });
  });

  describe('list', () => {
    beforeEach(() => {
      model.find.mockReturnValue(query([{ id: 'n1' }]));
      model.countDocuments.mockResolvedValue(45);
    });

    it('filtra SIEMPRE por el usuario, ordena de la más nueva a la más vieja y pagina', async () => {
      const find = query([{ id: 'n1' }]);
      model.find.mockReturnValue(find);

      const result = await service.list('cust-1', { page: 3, limit: 20 });

      expect(model.find).toHaveBeenCalledWith({ userId: 'cust-1' });
      expect(find.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(find.skip).toHaveBeenCalledWith(40);
      expect(find.limit).toHaveBeenCalledWith(20);
      expect(result).toMatchObject({ page: 3, limit: 20, total: 45, totalPages: 3 });
    });

    it('con unread=true agrega el filtro de no leídas', async () => {
      await service.list('cust-1', { unread: true });
      expect(model.find).toHaveBeenCalledWith({ userId: 'cust-1', read: false });
      expect(model.countDocuments).toHaveBeenCalledWith({ userId: 'cust-1', read: false });
    });

    it('con unread=false (o sin el parámetro) lista todas, leídas y no leídas', async () => {
      await service.list('cust-1', { unread: false });
      expect(model.find).toHaveBeenCalledWith({ userId: 'cust-1' });
    });

    it('devuelve además cuántas hay sin leer (para el contador), aunque la lista esté filtrada o paginada', async () => {
      model.countDocuments.mockImplementation((filter: { read?: boolean }) => Promise.resolve(filter.read === false ? 7 : 45));
      const result = await service.list('cust-1', { page: 2, limit: 10 });
      expect(result.unreadCount).toBe(7);
      expect(result.total).toBe(45);
    });

    it('sin parámetros usa página 1 y 20 por página', async () => {
      const find = query([]);
      model.find.mockReturnValue(find);
      await service.list('cust-1', {});
      expect(find.skip).toHaveBeenCalledWith(0);
      expect(find.limit).toHaveBeenCalledWith(20);
    });
  });

  describe('unreadCount', () => {
    it('cuenta solo las no leídas del usuario', async () => {
      model.countDocuments.mockResolvedValue(3);
      await expect(service.unreadCount('cust-1')).resolves.toBe(3);
      expect(model.countDocuments).toHaveBeenCalledWith({ userId: 'cust-1', read: false });
    });
  });

  describe('markRead', () => {
    const doc = (read: boolean) => ({ read, readAt: read ? new Date('2026-01-01') : null, save: jest.fn().mockResolvedValue(undefined) });

    it('la marca como leída con la fecha, buscando por id Y por dueño', async () => {
      const n = doc(false);
      model.findOne.mockResolvedValue(n);

      const result = await service.markRead('cust-1', OID);

      expect(model.findOne).toHaveBeenCalledWith({ _id: OID, userId: 'cust-1' });
      expect(n.read).toBe(true);
      expect(n.readAt).toBeInstanceOf(Date);
      expect(n.save).toHaveBeenCalledTimes(1);
      expect(result).toBe(n);
    });

    it('marcar una ya leída no la toca ni cambia la fecha original', async () => {
      const n = doc(true);
      model.findOne.mockResolvedValue(n);
      await service.markRead('cust-1', OID);
      expect(n.save).not.toHaveBeenCalled();
      expect(n.readAt).toEqual(new Date('2026-01-01'));
    });

    it('la de otra persona responde 404, igual que una inexistente (no revela que existe)', async () => {
      model.findOne.mockResolvedValue(null);
      await expect(service.markRead('intruso', OID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un id que no es un ObjectId da 404 sin consultar la base', async () => {
      await expect(service.markRead('cust-1', 'no-es-un-id')).rejects.toBeInstanceOf(NotFoundException);
      expect(model.findOne).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead', () => {
    it('actualiza solo las no leídas del usuario y devuelve cuántas', async () => {
      model.updateMany.mockResolvedValue({ modifiedCount: 4 });

      await expect(service.markAllRead('cust-1')).resolves.toEqual({ updated: 4 });

      expect(model.updateMany).toHaveBeenCalledWith(
        { userId: 'cust-1', read: false },
        { $set: { read: true, readAt: expect.any(Date) } },
      );
    });

    it('sin nada pendiente devuelve 0', async () => {
      model.updateMany.mockResolvedValue({ modifiedCount: 0 });
      await expect(service.markAllRead('cust-1')).resolves.toEqual({ updated: 0 });
    });
  });
});
