import { Request, Response } from 'express';
import { CORRELATION_HEADER, correlationIdMiddleware } from './correlation-id.middleware';

const run = (header?: string | string[]) => {
  const req = { headers: header === undefined ? {} : { [CORRELATION_HEADER]: header } } as unknown as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;
  const next = jest.fn();
  correlationIdMiddleware(req, res, next);
  return { req, res, next };
};

describe('correlationIdMiddleware', () => {
  it('respeta un id válido que manda el cliente y lo devuelve en la respuesta', () => {
    const { req, res, next } = run('mi-request-12345');

    expect(req.headers[CORRELATION_HEADER]).toBe('mi-request-12345');
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_HEADER, 'mi-request-12345');
    expect(next).toHaveBeenCalled();
  });

  it('genera un UUID si no viene ninguno', () => {
    const { req } = run();

    expect(req.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    ['muy corto', 'abc'],
    ['con caracteres raros', 'id con espacios\nY saltos'],
    ['enorme', 'x'.repeat(500)],
  ])('descarta un id inválido (%s) y genera uno nuevo', (_label, bad) => {
    const { req } = run(bad);

    expect(req.headers[CORRELATION_HEADER]).not.toBe(bad);
    expect(String(req.headers[CORRELATION_HEADER])).toHaveLength(36);
  });

  it('si el header viene repetido usa el primero', () => {
    const { req } = run(['primero-12345', 'segundo-12345']);

    expect(req.headers[CORRELATION_HEADER]).toBe('primero-12345');
  });
});
