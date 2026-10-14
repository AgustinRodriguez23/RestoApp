import {
  BadGatewayException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runWithContext } from '../observability/request-context';
import { RestaurantsClient } from './restaurants-client.service';

const ID = '64b7f0c2a1b2c3d4e5f60718';

const validBody = {
  id: ID,
  ownerId: 'owner-1',
  name: 'La Parrilla',
  cuisine: 'Parrilla', // campos que no usamos: tienen que ignorarse
  tables: [{ number: 1, capacity: 4, secret: 'x' }],
  openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
};

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('RestaurantsClient', () => {
  let client: RestaurantsClient;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock = jest.spyOn(globalThis, 'fetch');

    const config = {
      get: (key: string) =>
        ({
          RESTAURANTS_SERVICE_URL: 'http://restaurants:3002/', // con "/" final a propósito
          RESTAURANTS_SERVICE_RETRY_DELAY_MS: '0',
        })[key],
    } as unknown as ConfigService;
    client = new RestaurantsClient(config);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pide el restaurante a la URL correcta, con timeout, y devuelve solo los campos que usa', async () => {
    fetchMock.mockResolvedValue(json(200, validBody));

    const restaurant = await client.getRestaurant(ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://restaurants:3002/restaurants/${ID}`);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(restaurant).toEqual({
      id: ID,
      ownerId: 'owner-1',
      name: 'La Parrilla',
      tables: [{ number: 1, capacity: 4 }],
      openingHours: [{ dayOfWeek: 5, opens: '20:00', closes: '01:00' }],
    });
  });

  it('reenvía el correlationId de la request en curso, para cruzar los logs de ambos servicios', async () => {
    fetchMock.mockImplementation(async () => json(200, validBody));

    await runWithContext({ correlationId: 'traza-res-0001' }, () => client.getRestaurant(ID));
    await client.getRestaurant(ID); // fuera de una request (ej: una tarea interna)

    expect(fetchMock.mock.calls[0][1].headers['x-correlation-id']).toBe('traza-res-0001');
    expect(fetchMock.mock.calls[1][1].headers['x-correlation-id']).toBeUndefined();
  });

  it('responde 404 sin reintentar si el restaurante no existe', async () => {
    fetchMock.mockResolvedValue(json(404, { message: 'no existe' }));

    await expect(client.getRestaurant(ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reintenta una vez si restaurants-service responde 5xx y se recupera', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, validBody));

    await expect(client.getRestaurant(ID)).resolves.toMatchObject({ id: ID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('si sigue fallando responde 503 (no cuelga ni inventa datos)', async () => {
    fetchMock.mockResolvedValue(json(500, {}));

    await expect(client.getRestaurant(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un corte de red se trata igual: reintento y después 503', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.getRestaurant(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un timeout también cuenta como falla transitoria', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValueOnce(timeout).mockResolvedValueOnce(json(200, validBody));

    await expect(client.getRestaurant(ID)).resolves.toMatchObject({ id: ID });
  });

  it('un error 4xx inesperado es un 502 y no se reintenta (reintentar no lo arregla)', async () => {
    fetchMock.mockResolvedValue(json(400, { message: 'mal' }));

    await expect(client.getRestaurant(ID)).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una respuesta que no es JSON es un 502', async () => {
    fetchMock.mockResolvedValue(json(200, '<html>no soy json</html>'));

    await expect(client.getRestaurant(ID)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it.each([
    ['sin mesas', { ...validBody, tables: undefined }],
    ['con una mesa mal formada', { ...validBody, tables: [{ number: '1', capacity: 4 }] }],
    ['sin horarios', { ...validBody, openingHours: undefined }],
    ['sin dueño', { ...validBody, ownerId: undefined }],
    ['vacía', null],
  ])('una respuesta %s es un 502: no se confía en datos con otra forma', async (_label, body) => {
    fetchMock.mockResolvedValue(json(200, body));

    await expect(client.getRestaurant(ID)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
