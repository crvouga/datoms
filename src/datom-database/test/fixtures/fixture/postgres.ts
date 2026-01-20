import type {Fixture} from '../fixture.js';
import {PgSQLDatabase} from '../../../../sql-database/sql-database-pg.js';
import {PostgreSQLDatomDatabase} from '../../../postgres/postgres-datom-database.js';

const TEST_DATABASE_URL: string = 'postgresql://postgres:postgres@localhost:5433/postgres';

export const createPostgresFixture = async (): Promise<Fixture> => {
  const sqlDb = new PgSQLDatabase(TEST_DATABASE_URL);
  const tableName = 'datoms';
  const db = new PostgreSQLDatomDatabase({sqlDb: sqlDb, tableName});
  await db.initialize();
  const cleanUp = async () => {
    try {
      await sqlDb.execute(`DROP TABLE IF EXISTS ${tableName}, ${tableName}_tx`);
    } catch (error) {
      console.error('Error cleaning up Postgres tables', error);
    }
  };
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {
      await cleanUp();
      await db.close();
    },
  };
};
