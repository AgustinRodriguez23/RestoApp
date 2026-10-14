import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Reservation } from './entities/reservation.entity';

export const NO_OVERLAP_CONSTRAINT = 'reservations_no_overlap';

/**
 * Crea en PostgreSQL la restricción que garantiza que NUNCA haya dos reservas confirmadas
 * solapadas en la misma mesa de un restaurante.
 *
 * Por qué en la base y no solo en el código: chequear "¿está libre?" y después insertar no es
 * seguro cuando dos requests llegan a la vez (las dos ven la mesa libre y las dos reservan).
 * La base es el único lugar que puede decidir con certeza, porque serializa las escrituras.
 * El servicio solo intenta insertar y, si la base lo rechaza, prueba con otra mesa.
 *
 * Detalles de la restricción:
 * - EXCLUDE USING gist: "no pueden existir dos filas donde coincidan restaurante y mesa
 *   Y se solapen los rangos de tiempo". Necesita la extensión btree_gist para comparar con "=".
 * - tstzrange(starts_at, ends_at) es [inicio, fin): una reserva que termina a las 21:30 y otra
 *   que empieza a las 21:30 NO se solapan.
 * - WHERE status IN ('CONFIRMED','PENDING_PAYMENT'): una reserva esperando la seña ya retiene la mesa; las
 *   canceladas, vencidas, completadas y ausentes no la bloquean.
 *
 * TypeORM no sabe expresar esto con decoradores, por eso se aplica al iniciar. En producción
 * iría en una migración.
 */
@Injectable()
export class ReservationsSchemaBootstrap implements OnModuleInit {
  private readonly logger = new Logger(ReservationsSchemaBootstrap.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    const metadata = this.dataSource.getMetadata(Reservation);
    const table = metadata.schema
      ? `"${metadata.schema}"."${metadata.tableName}"`
      : `"${metadata.tableName}"`;

    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    const existing: Array<{ definition: string }> = await this.dataSource.query(
      'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass',
      [NO_OVERLAP_CONSTRAINT, table],
    );
    // Ya está con la definición actual (bloquea también PENDING_PAYMENT): nada que hacer
    if (existing.length > 0 && existing[0].definition.includes('PENDING_PAYMENT')) return;

    try {
      await this.dataSource.transaction(async (manager) => {
        // Versión anterior (solo CONFIRMED, de antes de existir la seña): se reemplaza en la misma transacción
        // para que nunca haya un instante sin restricción.
        if (existing.length > 0) {
          await manager.query(`ALTER TABLE ${table} DROP CONSTRAINT ${NO_OVERLAP_CONSTRAINT}`);
          this.logger.warn(`Actualizando la restricción ${NO_OVERLAP_CONSTRAINT} para que incluya PENDING_PAYMENT`);
        }
        await manager.query(`
          ALTER TABLE ${table}
          ADD CONSTRAINT ${NO_OVERLAP_CONSTRAINT}
          EXCLUDE USING gist (
            restaurant_id WITH =,
            table_number WITH =,
            tstzrange(starts_at, ends_at) WITH &&
          ) WHERE (status IN ('CONFIRMED', 'PENDING_PAYMENT'))
        `);
      });
      this.logger.log(`Restricción ${NO_OVERLAP_CONSTRAINT} creada`);
    } catch (error) {
      // 42710 = duplicate_object: otra instancia del servicio la creó justo antes que esta
      if ((error as { code?: string }).code !== '42710') throw error;
    }
  }
}
