import { HttpException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { IdempotencyKey } from './entities/idempotency-key.entity';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** true si es una respuesta guardada de un pedido anterior con la misma clave. */
  replayed: boolean;
}

/**
 * Idempotencia de pedidos HTTP con Idempotency-Key.
 *
 * Todo ocurre en UNA transacción de PostgreSQL:
 *   1. se inserta la clave (INSERT ... ON CONFLICT DO NOTHING);
 *   2. si ya existía, se devuelve la respuesta guardada (o 422 si el pedido es otro);
 *   3. si es nueva, se ejecuta el handler y se guarda la respuesta junto con su efecto.
 *
 * Por qué una sola transacción: si dos pedidos con la misma clave llegan a la vez, el segundo INSERT espera
 * (la base lo serializa) hasta que el primero termine, y después ve la respuesta ya guardada. No hace falta
 * un estado "en proceso", y si el proceso muere a mitad todo se revierte y la clave queda como si nunca se hubiera usado.
 *
 * Errores del cliente (4xx) se guardan y se repiten tal cual. Errores del servidor (5xx, inesperados) NO se
 * guardan: la transacción se revierte para que el cliente pueda reintentar con la misma clave.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly dataSource: DataSource) {}

  async run<T>(
    scope: string,
    key: string,
    request: unknown,
    handler: (manager: EntityManager) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    let clientError: HttpException | undefined;

    const outcome = await this.dataSource.transaction(async (manager) => {
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(IdempotencyKey)
        .values({ scope, key, requestHash })
        .orIgnore()
        .returning('key')
        .execute();

      if (inserted.raw.length === 0) {
        const existing = await manager.getRepository(IdempotencyKey).findOneByOrFail({ scope, key });
        if (existing.requestHash !== requestHash) {
          throw new UnprocessableEntityException('Esa Idempotency-Key ya se usó con un pedido distinto');
        }
        this.logger.log(`Idempotency-Key repetida: se devuelve la respuesta guardada (${existing.responseStatus})`);
        return { status: existing.responseStatus ?? 200, body: existing.responseBody as T, replayed: true };
      }

      let result: { status: number; body: unknown };
      try {
        result = await handler(manager);
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() < 500) {
          // Se guarda el error del cliente para repetirlo igual, y recién después de confirmar se vuelve a lanzar
          await manager
            .getRepository(IdempotencyKey)
            .update({ scope, key }, { responseStatus: error.getStatus(), responseBody: error.getResponse() as never });
          clientError = error;
          return { status: error.getStatus(), body: error.getResponse() as T, replayed: false };
        }
        throw error;
      }

      await manager
        .getRepository(IdempotencyKey)
        .update({ scope, key }, { responseStatus: result.status, responseBody: result.body as never });
      return { ...result, body: result.body as T, replayed: false };
    });

    if (clientError) throw clientError;
    // Respuesta guardada de un error: se vuelve a lanzar como el error que fue
    if (outcome.replayed && outcome.status >= 400) throw new HttpException(outcome.body as Record<string, unknown>, outcome.status);
    return outcome;
  }
}
