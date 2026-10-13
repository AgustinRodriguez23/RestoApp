import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Shift } from '../scheduling/schedule';

/** Lo que reservations-service necesita saber de un restaurante. */
export interface RestaurantInfo {
  id: string;
  ownerId: string;
  name: string;
  tables: { number: number; capacity: number }[];
  openingHours: Shift[];
}

/** Falla que vale la pena reintentar: red caída, timeout o error 5xx del otro servicio. */
class TransientError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cliente HTTP de restaurants-service. Es la parte "síncrona" de la arquitectura:
 * mientras restaurants-service no responda, no se puede reservar. Por eso tiene timeout
 * (nunca esperar para siempre) y un reintento (cubre un reinicio o un corte breve).
 */
@Injectable()
export class RestaurantsClient {
  private readonly logger = new Logger(RestaurantsClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts = 2;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('RESTAURANTS_SERVICE_URL') ?? 'http://localhost:3002').replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = Number(config.get('RESTAURANTS_SERVICE_TIMEOUT_MS') ?? 3000);
    this.retryDelayMs = Number(config.get('RESTAURANTS_SERVICE_RETRY_DELAY_MS') ?? 150);
  }

  async getRestaurant(id: string): Promise<RestaurantInfo> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.fetchRestaurant(id);
      } catch (error) {
        if (!(error instanceof TransientError)) throw error;

        this.logger.warn(
          `restaurants-service falló (intento ${attempt}/${this.maxAttempts}): ${error.message}`,
        );
        if (attempt >= this.maxAttempts) {
          throw new ServiceUnavailableException(
            'El servicio de restaurantes no está disponible. Probá de nuevo en unos segundos.',
          );
        }
        await sleep(this.retryDelayMs);
      }
    }
  }

  private async fetchRestaurant(id: string): Promise<RestaurantInfo> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/restaurants/${id}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      // Sin conexión o timeout
      throw new TransientError(error instanceof Error ? error.message : String(error));
    }

    if (response.status === 404) throw new NotFoundException('Restaurante no encontrado');
    if (response.status >= 500) throw new TransientError(`HTTP ${response.status}`);
    if (!response.ok) {
      throw new BadGatewayException(
        `El servicio de restaurantes respondió con un error inesperado (HTTP ${response.status})`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BadGatewayException('El servicio de restaurantes devolvió una respuesta inválida');
    }
    return this.parse(body);
  }

  /** No se confía a ciegas en lo que devuelve otro servicio: se valida la forma de lo que se usa. */
  private parse(body: unknown): RestaurantInfo {
    const data = body as Partial<RestaurantInfo> | null;
    const valid =
      !!data &&
      typeof data.id === 'string' &&
      typeof data.ownerId === 'string' &&
      Array.isArray(data.tables) &&
      data.tables.every((t) => typeof t?.number === 'number' && typeof t?.capacity === 'number') &&
      Array.isArray(data.openingHours) &&
      data.openingHours.every(
        (h) =>
          typeof h?.dayOfWeek === 'number' && typeof h?.opens === 'string' && typeof h?.closes === 'string',
      );

    if (!valid) {
      throw new BadGatewayException('El servicio de restaurantes devolvió datos con un formato inesperado');
    }
    return {
      id: data.id!,
      ownerId: data.ownerId!,
      name: typeof data.name === 'string' ? data.name : '',
      tables: data.tables!.map(({ number, capacity }) => ({ number, capacity })),
      openingHours: data.openingHours!.map(({ dayOfWeek, opens, closes }) => ({
        dayOfWeek,
        opens,
        closes,
      })),
    };
  }
}
