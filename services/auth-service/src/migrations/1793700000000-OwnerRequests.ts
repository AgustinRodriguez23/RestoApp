import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Solicitudes para ser dueño y el rol ADMIN que las revisa. Generada con `migration:generate` y retocada a mano:
 * - Sin "public" ni otro schema en los tipos, como la inicial (respeta el search_path).
 * - El rol nuevo se agrega con ADD VALUE: lo que genera TypeORM (crear otro enum y cambiarle el tipo a la columna)
 *   reescribe toda la tabla users con un bloqueo. IF NOT EXISTS por las bases que creó synchronize, que ya lo tienen.
 *   Postgres permite ADD VALUE dentro de una transacción, pero no usar el valor nuevo en esa misma: acá no se usa.
 */
export class OwnerRequests1793700000000 implements MigrationInterface {
  name = 'OwnerRequests1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'ADMIN'`);

    await queryRunner.query(`CREATE TYPE "owner_requests_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED')`);
    await queryRunner.query(
      `CREATE TABLE "owner_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "restaurant_name" character varying(100) NOT NULL, "address" character varying(200) NOT NULL, "phone" character varying(30) NOT NULL, "message" character varying(1000), "status" "owner_requests_status_enum" NOT NULL DEFAULT 'PENDING', "rejection_reason" character varying(300), "reviewed_by" uuid, "reviewed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e1f93503ea632e6066d38287f08" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_47e92d581b12c834e3b98286c7" ON "owner_requests" ("status", "created_at")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_owner_requests_pending_user" ON "owner_requests" ("user_id") WHERE "status" = 'PENDING'`,
    );
    await queryRunner.query(
      `ALTER TABLE "owner_requests" ADD CONSTRAINT "FK_163095de3e2e470c84fb89b54c5" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "owner_requests"`);
    await queryRunner.query(`DROP TYPE "owner_requests_status_enum"`);

    // Un valor no se puede sacar de un enum: se crea otro sin él. Los admins vuelven a ser clientes.
    await queryRunner.query(`UPDATE "users" SET "role" = 'CUSTOMER' WHERE "role" = 'ADMIN'`);
    await queryRunner.query(`ALTER TYPE "users_role_enum" RENAME TO "users_role_enum_old"`);
    await queryRunner.query(`CREATE TYPE "users_role_enum" AS ENUM('CUSTOMER', 'RESTAURANT_OWNER')`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE "users_role_enum" USING "role"::"text"::"users_role_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'CUSTOMER'`);
    await queryRunner.query(`DROP TYPE "users_role_enum_old"`);
  }
}
