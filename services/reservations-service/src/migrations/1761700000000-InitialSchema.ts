import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema inicial, generado con `migration:generate` sobre una base vacía y retocado a mano:
 * - Los enums van sin "public": así respetan el search_path y caen en el schema del servicio.
 * - Las extensiones las crea esta migración (installExtensions está apagado en database.config).
 * - Si la tabla ya existe la base es de antes de las migraciones (la creaba synchronize): queda registrada sin
 *   tocar nada. El test de migraciones comprueba que ese esquema y el de esta migración son el mismo.
 */
export class InitialSchema1761700000000 implements MigrationInterface {
  name = 'InitialSchema1761700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('reservations')) return;

    // uuid_generate_v4() para los ids, y btree_gist para comparar con "=" dentro de la restricción de exclusión
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public`);

    await queryRunner.query(
      `CREATE TABLE "outbox_messages" ("id" uuid NOT NULL, "type" character varying(100) NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_error" text, CONSTRAINT "PK_0171348f527c64b137e4d4f5b66" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2e592fb4c609b30f2927501846" ON "outbox_messages" ("published_at", "next_attempt_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "processed_messages" ("consumer" character varying(100) NOT NULL, "message_id" uuid NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d4853eee97acfc588e49f9290d1" PRIMARY KEY ("consumer", "message_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "reservations_status_enum" AS ENUM('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW')`,
    );
    await queryRunner.query(
      `CREATE TABLE "reservations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "restaurant_id" character varying(24) NOT NULL, "table_number" integer NOT NULL, "customer_id" character varying NOT NULL, "customer_name" character varying(100), "restaurant_name" character varying(100), "party_size" integer NOT NULL, "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ends_at" TIMESTAMP WITH TIME ZONE NOT NULL, "status" "reservations_status_enum" NOT NULL DEFAULT 'CONFIRMED', "notes" character varying(300), "deposit_cents" integer NOT NULL DEFAULT '0', "expires_at" TIMESTAMP WITH TIME ZONE, "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "reservations_no_overlap" EXCLUDE USING gist (restaurant_id WITH =, table_number WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('CONFIRMED', 'PENDING_PAYMENT')), CONSTRAINT "PK_da95cef71b617ac35dc5bcda243" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_ea9ecedd029b9d302218892058" ON "reservations" ("status", "expires_at")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_1edda2f383c8f80eaae60ebc9b" ON "reservations" ("restaurant_id", "starts_at")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_000988f1fd48ee549c9b521697" ON "reservations" ("customer_id", "starts_at")`);
  }

  /** Las extensiones quedan: son de toda la base y otro schema puede estar usándolas. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reservations"`);
    await queryRunner.query(`DROP TYPE "reservations_status_enum"`);
    await queryRunner.query(`DROP TABLE "processed_messages"`);
    await queryRunner.query(`DROP TABLE "outbox_messages"`);
  }
}
