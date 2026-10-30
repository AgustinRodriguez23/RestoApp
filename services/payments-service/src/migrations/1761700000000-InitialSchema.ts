import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema inicial, generado con `migration:generate` sobre una base vacía y retocado a mano:
 * - Los enums van sin "public": así respetan el search_path y caen en el schema del servicio.
 * - La extensión la crea esta migración (installExtensions está apagado en database.config).
 * - Si la tabla ya existe la base es de antes de las migraciones (la creaba synchronize): queda registrada sin
 *   tocar nada. El test de migraciones comprueba que ese esquema y el de esta migración son el mismo.
 */
export class InitialSchema1761700000000 implements MigrationInterface {
  name = 'InitialSchema1761700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('payments')) return;

    // uuid_generate_v4() para los ids
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);

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
      `CREATE TABLE "gateway_events" ("provider" character varying(30) NOT NULL, "event_id" character varying(100) NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d8524a8a8b71e8c9b1a8aad207e" PRIMARY KEY ("provider", "event_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("scope" character varying NOT NULL, "key" character varying(100) NOT NULL, "request_hash" character varying(64) NOT NULL, "response_status" integer, "response_body" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_15de2f76fa9f27ad8f330983607" PRIMARY KEY ("scope", "key"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "payments_status_enum" AS ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "reservation_id" uuid NOT NULL, "customer_id" character varying NOT NULL, "restaurant_id" character varying(24) NOT NULL, "amount_cents" integer NOT NULL, "currency" character varying(3) NOT NULL, "status" "payments_status_enum" NOT NULL DEFAULT 'PENDING', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "provider" character varying(30), "provider_charge_id" character varying, "provider_refund_id" character varying, "failure_reason" character varying(200), "paid_at" TIMESTAMP WITH TIME ZONE, "refunded_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9ed5ff4942e09edfd44ee0ccf0" ON "payments" ("reservation_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_756f372f43e1e0e08960fc76f3" ON "payments" ("provider_charge_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_2b263416b5421c53bc5bab4bf8" ON "payments" ("customer_id", "created_at")`);
  }

  /** La extensión queda: es de toda la base y otro schema puede estar usándola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP TYPE "payments_status_enum"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE "gateway_events"`);
    await queryRunner.query(`DROP TABLE "processed_messages"`);
    await queryRunner.query(`DROP TABLE "outbox_messages"`);
  }
}
