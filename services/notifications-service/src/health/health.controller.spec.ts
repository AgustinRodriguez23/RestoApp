import { ServiceUnavailableException } from '@nestjs/common';
import { Connection } from 'mongoose';
import { RabbitConnection } from '../messaging/rabbit-connection';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const ping = jest.fn();
  const connection = { db: { admin: () => ({ ping }) } } as unknown as Connection;
  const rabbit = (enabled: boolean, isUp: boolean) => ({ enabled, isUp }) as unknown as RabbitConnection;

  beforeEach(() => ping.mockReset().mockResolvedValue({ ok: 1 }));

  it('reporta base y mensajería arriba', async () => {
    await expect(new HealthController(connection, rabbit(true, true)).check()).resolves.toEqual({
      status: 'ok',
      service: 'notifications-service',
      database: 'up',
      messaging: 'up',
    });
  });

  it('RabbitMQ caído NO baja el servicio: sigue "ok" porque la bandeja se puede leer', async () => {
    const result = await new HealthController(connection, rabbit(true, false)).check();
    expect(result).toMatchObject({ status: 'ok', messaging: 'down' });
  });

  it('sin RABBITMQ_URL la mensajería figura como deshabilitada', async () => {
    const result = await new HealthController(connection, rabbit(false, false)).check();
    expect(result.messaging).toBe('disabled');
  });

  it('si Mongo no responde, 503', async () => {
    ping.mockRejectedValue(new Error('down'));
    await expect(new HealthController(connection, rabbit(true, true)).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('sin conexión a la base (db sin inicializar), también 503', async () => {
    const sinDb = { db: undefined } as unknown as Connection;
    await expect(new HealthController(sinDb, rabbit(true, true)).check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
