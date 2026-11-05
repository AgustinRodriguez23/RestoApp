import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bandeja de salida de eventos (transactional outbox), la misma tabla que tienen reservations y payments.
 * El SQL es el de la migración inicial de reservations (misma entidad, mismos nombres de índice); el test de
 * migraciones comprueba que coincide con la entidad. Solo agrega una tabla: no toca los datos que ya hay.
 */
export class Outbox1793800000000 implements MigrationInterface {
  name = 'Outbox1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "outbox_messages" ("id" uuid NOT NULL, "type" character varying(100) NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_error" text, CONSTRAINT "PK_0171348f527c64b137e4d4f5b66" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2e592fb4c609b30f2927501846" ON "outbox_messages" ("published_at", "next_attempt_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "outbox_messages"`);
  }
}
