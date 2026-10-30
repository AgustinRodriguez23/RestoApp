/**
 * Las migraciones contra un PostgreSQL REAL. Comprueban que:
 * - en una base vacía dejan exactamente el esquema que describen las entidades: si alguien cambia una entidad y
 *   se olvida de generar la migración, esto falla (y CI con él);
 * - se pueden revertir del todo y volver a aplicar;
 * - en una base de antes de las migraciones (las tablas las creaba synchronize) quedan registradas sin tocar los datos.
 *
 * Cómo correrlas:  npm run infra:up  y después  npm run test:integration
 * Cada caso usa su propio schema temporal (it_mig_...), que se borra al final.
 */
import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { typeOrmOptions } from '../database.config';

const PREFIX = `it_mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const INITIAL = 'InitialSchema1761700000000';

describe('migraciones de auth-service (PostgreSQL real)', () => {
  let admin: DataSource;
  const opened: DataSource[] = [];
  const schemas: string[] = [];

  /** Las mismas opciones que usa la app, en otro schema y sin aplicar nada al conectar. */
  function options(schema: string): DataSourceOptions {
    process.env.DB_SCHEMA = schema;
    return { ...typeOrmOptions(new ConfigService()), migrationsRun: false } as DataSourceOptions;
  }

  async function connect(schema: string, overrides: Partial<DataSourceOptions> = {}): Promise<DataSource> {
    if (!schemas.includes(schema)) {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemas.push(schema);
    }
    const ds = await new DataSource({ ...options(schema), ...overrides } as DataSourceOptions).initialize();
    opened.push(ds);
    return ds;
  }

  /** Lo que TypeORM cambiaría para que la base coincida con las entidades. Vacío = coinciden. */
  async function pendingChanges(ds: DataSource): Promise<string[]> {
    const sql = await ds.driver.createSchemaBuilder().log();
    return sql.upQueries.map((query) => query.query);
  }

  const leftovers = (ds: DataSource, schema: string) =>
    ds.query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 AND table_name <> 'migrations'
       UNION ALL SELECT typname FROM pg_type WHERE typnamespace = $1::regnamespace AND typtype = 'e'`,
      [schema],
    );

  beforeAll(async () => {
    const env = process.env;
    Object.assign(process.env, {
      DB_HOST: env.TEST_DB_HOST ?? 'localhost',
      DB_PORT: env.TEST_DB_PORT ?? '5433',
      DB_USER: env.TEST_DB_USER ?? 'auth',
      DB_PASSWORD: env.TEST_DB_PASSWORD ?? 'auth_password',
      DB_NAME: env.TEST_DB_NAME ?? 'auth_db',
    });
    admin = await new DataSource({ ...options(''), migrations: [] }).initialize();
  });

  afterAll(async () => {
    await Promise.all(opened.filter((ds) => ds.isInitialized).map((ds) => ds.destroy()));
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.destroy();
  });

  it('en una base vacía crean exactamente el esquema de las entidades', async () => {
    const ds = await connect(`${PREFIX}_new`);

    const applied = await ds.runMigrations();

    expect(applied.map((migration) => migration.name)).toEqual([INITIAL]);
    expect(await pendingChanges(ds)).toEqual([]);
    // Y volver a correrlas no hace nada
    expect(await ds.runMigrations()).toEqual([]);
  });

  it('se pueden revertir del todo y volver a aplicar', async () => {
    const schema = `${PREFIX}_undo`;
    const ds = await connect(schema);
    await ds.runMigrations();

    await ds.undoLastMigration();

    expect(await leftovers(ds, schema)).toEqual([]);
    await ds.runMigrations();
    expect(await pendingChanges(ds)).toEqual([]);
  });

  it('en una base creada con synchronize (de antes de las migraciones) se registran sin tocar los datos', async () => {
    const schema = `${PREFIX}_legacy`;
    // Lo que hacía la app antes: el driver instalaba la extensión y synchronize creaba las tablas
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    const legacy = await connect(schema, { migrations: [], synchronize: true });
    await legacy.query(`INSERT INTO users (email, name, password_hash) VALUES ('legado@example.com', 'Legado', 'x')`);
    await legacy.destroy();

    const ds = await connect(schema);
    const applied = await ds.runMigrations();

    expect(applied.map((migration) => migration.name)).toEqual([INITIAL]);
    expect(await pendingChanges(ds)).toEqual([]);
    expect(await ds.query('SELECT email FROM users')).toEqual([{ email: 'legado@example.com' }]);
  });
});
