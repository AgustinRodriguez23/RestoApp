import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { currentCorrelationId } from '../observability/request-context';

export type UpstreamName = 'auth' | 'restaurants' | 'reservations' | 'payments';

/** Lo que el BFF reenvía del request original a los servicios. */
export interface CallContext {
  /** JWT del usuario (sin "Bearer "). */
  token?: string;
  correlationId?: string;
}

export interface UpstreamCall {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Headers extra a reenviar (por ejemplo Idempotency-Key). */
  headers?: Record<string, string>;
}

/** Respuesta con el status HTTP, para los casos en que importa distinguir 200 de 202. */
export interface UpstreamResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

const DEFAULT_URLS: Record<UpstreamName, string> = {
  auth: 'http://localhost:3001',
  restaurants: 'http://localhost:3002',
  reservations: 'http://localhost:3003',
  payments: 'http://localhost:3004',
};
const URL_VARS: Record<UpstreamName, string> = {
  auth: 'AUTH_SERVICE_URL',
  restaurants: 'RESTAURANTS_SERVICE_URL',
  reservations: 'RESERVATIONS_SERVICE_URL',
  payments: 'PAYMENTS_SERVICE_URL',
};

/** Falla que vale la pena reintentar (si el pedido es seguro de repetir). */
class TransientError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network' | 'server',
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Único lugar por el que el BFF habla con los servicios. Centraliza lo que no se quiere repetir:
 *  - timeout en TODA llamada (nunca esperar para siempre a un servicio caído);
 *  - reintento solo de GET (repetir un GET es inofensivo; repetir un POST podría duplicar una reserva);
 *  - reenvío del token del usuario y del x-correlation-id;
 *  - traducción de errores: un 4xx del servicio (400, 404, 409...) se devuelve igual, porque es
 *    una respuesta válida para el usuario; un 5xx, un timeout o un corte de red se vuelven
 *    502/503/504, que significan "el problema está atrás, no en tu pedido".
 */
@Injectable()
export class UpstreamClient {
  private readonly logger = new Logger(UpstreamClient.name);
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxGetAttempts = 2;

  constructor(private readonly config: ConfigService) {
    this.timeoutMs = Number(config.get('UPSTREAM_TIMEOUT_MS') ?? 3000);
    this.retryDelayMs = Number(config.get('UPSTREAM_RETRY_DELAY_MS') ?? 100);
  }

  async call<T = unknown>(service: UpstreamName, call: UpstreamCall, ctx: CallContext = {}): Promise<T> {
    return (await this.callWithStatus<T>(service, call, ctx)).body;
  }

  /** Igual que `call`, pero devuelve también el status de la respuesta (200, 202...). */
  async callWithStatus<T = unknown>(service: UpstreamName, call: UpstreamCall, ctx: CallContext = {}): Promise<UpstreamResponse<T>> {
    const method = call.method ?? 'GET';
    const attempts = method === 'GET' ? this.maxGetAttempts : 1;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(service, method, call, ctx);
      } catch (error) {
        if (!(error instanceof TransientError)) throw error;
        if (attempt < attempts) {
          this.logger.warn(`${service} ${method} ${call.path}: ${error.message}. Reintentando...`);
          await sleep(this.retryDelayMs);
          continue;
        }
        this.logger.warn(`${service} ${method} ${call.path}: ${error.message}`);
        throw this.toHttpError(service, error);
      }
    }
  }

  private async once<T>(service: UpstreamName, method: string, call: UpstreamCall, ctx: CallContext): Promise<UpstreamResponse<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...call.headers };
    if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
    const correlationId = ctx.correlationId ?? currentCorrelationId();
    if (correlationId) headers['x-correlation-id'] = correlationId;
    if (call.body !== undefined) headers['Content-Type'] = 'application/json';

    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
    const info = { upstream: service, method, path: call.path };

    let response: Response;
    try {
      response = await fetch(this.buildUrl(service, call), {
        method,
        headers,
        body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      this.logger.warn({ message: 'upstream call failed', ...info, reason: timedOut ? 'timeout' : 'network', durationMs: elapsed() });
      if (timedOut) throw new TransientError(`no respondió en ${this.timeoutMs} ms`, 'timeout');
      throw new TransientError(`no se pudo conectar (${(error as Error).message})`, 'network');
    }

    const text = await response.text();
    // Cada llamada a otro servicio queda registrada con su duración: así se ve dónde se fue el tiempo de una request
    const outcome = { message: 'upstream call', ...info, status: response.status, durationMs: elapsed() };
    if (response.status >= 500) this.logger.warn(outcome);
    else if (call.path === '/health') this.logger.debug(outcome); // los chequeos de salud se repiten: no ensuciar los logs
    else this.logger.log(outcome);
    if (response.status >= 500) throw new TransientError(`respondió ${response.status}`, 'server');

    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new BadGatewayException(`${service}-service devolvió una respuesta que no es JSON`);
      }
    }

    if (!response.ok) {
      // 4xx: el servicio rechazó el pedido con una razón válida. Se la pasamos al usuario tal cual.
      const body = (parsed ?? {}) as { message?: string | string[]; error?: string };
      throw new HttpException(
        { statusCode: response.status, error: body.error ?? response.statusText, message: body.message ?? response.statusText },
        response.status,
      );
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  private buildUrl(service: UpstreamName, call: UpstreamCall): string {
    const base = (this.config.get<string>(URL_VARS[service]) ?? DEFAULT_URLS[service]).replace(/\/+$/, '');
    const url = new URL(base + call.path);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private toHttpError(service: UpstreamName, error: TransientError): HttpException {
    if (error.kind === 'timeout') return new GatewayTimeoutException(`${service}-service tardó demasiado en responder`);
    if (error.kind === 'network') return new ServiceUnavailableException(`${service}-service no está disponible`);
    return new BadGatewayException(`${service}-service falló al procesar el pedido`);
  }
}
