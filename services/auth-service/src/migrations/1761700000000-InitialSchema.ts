import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema inicial, generado con `migration:generate` sobre una base vacía y retocado a mano:
 * - El enum va sin "public": así respeta el search_path y cae en el schema del servicio.
 * - La extensión la crea esta migración (installExtensions está apagado en database.config).
 * - Si la tabla ya existe la base es de antes de las migraciones (la creaba synchronize): queda registrada sin
 *   tocar nada. El test de migraciones comprueba que ese esquema y el de esta migración son el mismo.
 */
export class InitialSchema1761700000000 implements MigrationInterface {
  name = 'InitialSchema1761700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('users')) return;

    // uuid_generate_v4() para los ids
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);

    await queryRunner.query(`CREATE TYPE "users_role_enum" AS ENUM('CUSTOMER', 'RESTAURANT_OWNER')`);
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "name" character varying NOT NULL, "password_hash" character varying NOT NULL, "role" "users_role_enum" NOT NULL DEFAULT 'CUSTOMER', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
  }

  /** La extensión queda: es de toda la base y otro schema puede estar usándola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "users_role_enum"`);
  }
}
