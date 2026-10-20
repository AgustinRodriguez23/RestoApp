import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { getRequestContext, runWithContext } from './request-context';

const logger = new Logger('HTTP');

/**
 * Una línea de log por request, cuando termina: método, ruta, status y cuánto tardó.
 * Es la base de la trazabilidad: permite ver qué pasó con cada request y qué tan lenta fue.
 *
 * Qué NO se loguea, a propósito: query string (puede traer datos), body y headers
 * (contienen contraseñas y tokens). Solo la ruta.
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  // Se captura ahora: es el mismo objeto que el guard completa con el userId. Dentro de 'finish' el
  // contexto asíncrono no está garantizado, así que se vuelve a abrir explícitamente.
  const context = getRequestContext();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const path = (req.originalUrl ?? req.url).split('?')[0];
    const entry = {
      message: 'request completed',
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    };

    const write = () => {
      // Los health checks se consultan constantemente: no ensuciar los logs
      if (path === '/health') logger.debug(entry);
      else if (res.statusCode >= 500) logger.error(entry);
      else if (res.statusCode >= 400) logger.warn(entry);
      else logger.log(entry);
    };
    if (context) runWithContext(context, write);
    else write();
  });

  next();
}
