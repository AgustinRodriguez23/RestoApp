import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

// Solo se acepta un id "razonable": evita que un cliente meta basura o textos enormes en los logs
const SAFE_ID = /^[A-Za-z0-9._-]{8,100}$/;

/**
 * Cada request recibe un id que viaja por todos los servicios. Si el cliente ya manda uno
 * válido se respeta; si no, se genera. También se devuelve en la respuesta, así quien reporta
 * un error puede decir "mi request fue X" y se encuentra en los logs de todos los servicios.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();

  req.headers[CORRELATION_HEADER] = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}
