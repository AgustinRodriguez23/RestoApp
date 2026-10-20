import { ArgumentsHost, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function buildHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/notifications' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('mantiene el status y mensaje de una HttpException', () => {
    const { host, status, json } = buildHost();

    filter.catch(new NotFoundException('No encontrado'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'No encontrado', path: '/notifications' }),
    );
  });

  it('conserva la lista de mensajes de validación', () => {
    const { host, json } = buildHost();

    filter.catch(new BadRequestException(['name too short', 'tables must not be empty']), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: ['name too short', 'tables must not be empty'],
      }),
    );
  });

  it('oculta los detalles de errores inesperados con un 500 genérico', () => {
    const { host, status, json } = buildHost();

    filter.catch(new Error('mongodb://user:secreto@host/db falló'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe('Error interno del servidor');
    expect(JSON.stringify(body)).not.toContain('secreto');
  });
});
