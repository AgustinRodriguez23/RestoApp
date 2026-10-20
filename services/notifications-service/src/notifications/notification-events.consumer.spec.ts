import { ConfigService } from '@nestjs/config';
import { EventConsumers } from '../messaging/event-consumers.service';
import { EventEnvelope, PoisonMessageError } from '../messaging/event-envelope';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { NotificationsService } from './notifications.service';

const envelope = (type: string, data: Record<string, unknown>): EventEnvelope => ({
  id: 'evt-1',
  type,
  occurredAt: '2026-10-20T12:00:00.000Z',
  correlationId: 'corr-1',
  data,
});
const data = { reservationId: 'res-1', customerId: 'cust-1', restaurantId: 'rest-1', restaurantName: 'La Parrilla' };

describe('NotificationEventsConsumer', () => {
  const notifications = { createFromEvent: jest.fn() };
  const consumers = { register: jest.fn() };
  const config = (values: Record<string, string> = {}) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const build = (values?: Record<string, string>) =>
    new NotificationEventsConsumer(
      consumers as unknown as EventConsumers,
      notifications as unknown as NotificationsService,
      config(values),
    );

  beforeEach(() => jest.resetAllMocks());

  it('un evento nuevo crea la notificación con el id del evento como clave de idempotencia', async () => {
    notifications.createFromEvent.mockResolvedValue('created');
    await expect(build().handle(envelope('reservation.confirmed', data))).resolves.toBe('processed');
    expect(notifications.createFromEvent).toHaveBeenCalledWith(
      'evt-1',
      expect.objectContaining({ userId: 'cust-1', type: 'RESERVATION_CONFIRMED' }),
    );
  });

  it('un evento ya procesado se informa como duplicado', async () => {
    notifications.createFromEvent.mockResolvedValue('duplicate');
    await expect(build().handle(envelope('reservation.confirmed', data))).resolves.toBe('duplicate');
  });

  it('si no hay nada que avisar (canceló el propio cliente), no toca la base y se da por procesado', async () => {
    await expect(build().handle(envelope('reservation.cancelled', { ...data, reason: 'CANCELLED_BY_CUSTOMER' }))).resolves.toBe('processed');
    expect(notifications.createFromEvent).not.toHaveBeenCalled();
  });

  it('un evento irrecuperable propaga el PoisonMessageError (va a la DLQ) sin escribir', async () => {
    await expect(build().handle(envelope('reservation.confirmed', { reservationId: 'res-1' }))).rejects.toBeInstanceOf(PoisonMessageError);
    expect(notifications.createFromEvent).not.toHaveBeenCalled();
  });

  it('un fallo de la base se propaga: el mensaje se reintenta', async () => {
    notifications.createFromEvent.mockRejectedValue(new Error('mongo caído'));
    await expect(build().handle(envelope('reservation.confirmed', data))).rejects.toThrow('mongo caído');
  });

  describe('registro del consumidor', () => {
    it('escucha confirmada, cancelada y vencida, y NINGÚN otro evento (por ejemplo, no reservation.created)', async () => {
      await build().onModuleInit();
      const def = consumers.register.mock.calls[0][0];
      expect(def.bindings.sort()).toEqual(['reservation.cancelled', 'reservation.confirmed', 'reservation.expired']);
      expect(def.maxAttempts).toBe(5);
    });

    it('el nombre de la cola lleva el prefijo del entorno (aísla entornos que comparten broker)', () => {
      expect(build({ RABBITMQ_QUEUE_PREFIX: 'e2e.' }).queueName).toBe('e2e.notifications-service.reservations');
      expect(build().queueName).toBe('notifications-service.reservations');
    });

    it('la demora de reintento sale de RABBITMQ_RETRY_DELAY_MS', async () => {
      await build({ RABBITMQ_RETRY_DELAY_MS: '250' }).onModuleInit();
      expect(consumers.register.mock.calls[0][0].retryDelayMs).toBe(250);
    });
  });
});
