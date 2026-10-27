import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail, ThrottlerModuleOptions } from '@nestjs/throttler';
import { Request } from 'express';

/** Ventana de todos los límites de auth: 15 minutos. */
export const WINDOW_MS = 15 * 60_000;

/** Nombres de los límites, para elegir cuáles aplican en cada ruta (@Throttle / @SkipThrottle). */
export const THROTTLE_IP = 'ip';
export const THROTTLE_ACCOUNT = 'account';

/** Altas permitidas por IP cada 15 minutos (una corrida del e2e hace 9). */
export const REGISTER_LIMIT = 30;

/**
 * Límites de login y registro. Van en el BFF porque es la entrada: es el único que ve la IP del cliente
 * (con nginx adelante y TRUST_PROXY). auth-service ve todo como si viniera del BFF.
 *
 * - account (IP + email): 10 intentos cada 15 min. Frena adivinar la contraseña de una cuenta; no es por email
 *   solo para que alguien desde otra IP no pueda bloquearle el login a la víctima.
 * - ip: 50 intentos cada 15 min sumando todas las cuentas. Frena probar muchas cuentas desde el mismo lugar.
 *
 * El contador vive en memoria: alcanza con una sola instancia del BFF. Con varias habría que pasarlo a Redis
 * (ThrottlerStorage), si no cada una cuenta por su lado.
 */
export const authThrottlerOptions: ThrottlerModuleOptions = {
  throttlers: [
    { name: THROTTLE_IP, limit: 50, ttl: WINDOW_MS },
    {
      name: THROTTLE_ACCOUNT,
      limit: 10,
      ttl: WINDOW_MS,
      // El guard corre antes que la validación, así que el body todavía puede traer cualquier cosa
      getTracker: (req) => {
        const { ip, body } = req as Pick<Request, 'ip' | 'body'>;
        return `${ip}|${String((body as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase()}`;
      },
    },
  ],
  errorMessage: 'Demasiados intentos. Esperá unos minutos y volvé a probar.',
};

/** Igual que ThrottlerGuard, pero el 429 sale con el formato de error de siempre ({ error: 'Too Many Requests', ... }). */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const message = await this.getErrorMessage(context, detail);
    throw new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
