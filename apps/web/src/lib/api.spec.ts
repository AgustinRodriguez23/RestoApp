import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, configureApi, request } from './api';
import { mockApi } from '../test/harness';

afterEach(() => {
  configureApi({ getToken: () => null, onUnauthorized: () => undefined });
});

describe('cliente de la API', () => {
  it('manda el token como Bearer y omite los parámetros vacíos', async () => {
    const server = mockApi({ 'GET /restaurants': { body: { data: [] } } });
    configureApi({ getToken: () => 'abc', onUnauthorized: vi.fn() });

    await api.get('/restaurants', { search: '', cuisine: undefined, page: 2 });

    expect(server.calls[0]?.headers.Authorization).toBe('Bearer abc');
    expect(server.calls[0]?.query).toEqual({ page: '2' });
  });

  it('une la lista de mensajes de validación en un texto', async () => {
    mockApi({ 'POST /reservations': { status: 400, body: { message: ['partySize debe ser mayor a 0', 'startsAt inválido'] } } });
    await expect(api.post('/reservations', {})).rejects.toMatchObject({ status: 400, message: 'partySize debe ser mayor a 0. startsAt inválido' });
  });

  it('conserva el id de seguimiento del servidor', async () => {
    mockApi({ 'GET /x': { status: 502, body: { message: 'x' }, headers: { 'x-correlation-id': 'corr-123' } } });
    await expect(api.get('/x')).rejects.toMatchObject({ status: 502, correlationId: 'corr-123' });
  });

  it('un 5xx sin mensaje no muestra detalles técnicos', async () => {
    mockApi({ 'GET /x': { status: 500, body: {} } });
    await expect(api.get('/x')).rejects.toThrow('Algo falló de nuestro lado');
  });

  it('sin respuesta del servidor da status 0 y un mensaje claro', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = await api.get('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0 });
    expect((error as Error).message).toMatch(/conectar/);
  });

  it('un 401 con sesión cierra la sesión; sin sesión (login) no', async () => {
    mockApi({ 'GET /auth/me': { status: 401, body: { message: 'Token inválido' } }, 'POST /auth/login': { status: 401, body: { message: 'Credenciales inválidas' } } });
    const onUnauthorized = vi.fn();

    configureApi({ getToken: () => null, onUnauthorized });
    await expect(api.post('/auth/login', {})).rejects.toThrow('Credenciales inválidas');
    expect(onUnauthorized).not.toHaveBeenCalled();

    configureApi({ getToken: () => 'vencido', onUnauthorized });
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('request informa el status (202) y si la respuesta fue una repetición idempotente', async () => {
    mockApi({ 'POST /p': { status: 202, body: { ok: true }, headers: { 'idempotent-replayed': 'true' } } });
    const response = await request<{ ok: boolean }>('/p', { method: 'POST', body: {} });
    expect(response).toMatchObject({ status: 202, replayed: true, data: { ok: true } });
  });
});
