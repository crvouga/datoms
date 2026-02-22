import {PgSQLDatabase} from 'datoms/adapters/pg';
import type {Fixture} from '../fixture.js';
import {PostgreSQLDatomDatabase} from '../../../postgres/postgres-datom-database.js';

const TEST_DATABASE_URL: string = 'postgresql://postgres:postgres@localhost:25533/postgres';

export const createPostgresFixture = async (): Promise<Fixture> => {
  const sqlDb = new PgSQLDatabase(TEST_DATABASE_URL);
  const tableName = 'datoms';
  const db = new PostgreSQLDatomDatabase({sqlDb: sqlDb, tableName});
  await db.initialize();
  const cleanUpData = async () => {
    // Delete all data from tables without dropping them
    try {
      await sqlDb.query(`DELETE FROM ${tableName}`);
      await sqlDb.query(`DELETE FROM ${tableName}_tx`);
      // Reset the transaction counter
      await sqlDb.query(
        `INSERT INTO ${tableName}_tx (id, last_tx) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET last_tx = 0`,
      );
    } catch (error) {
      console.error('Error cleaning up Postgres data', error);
    }
  };
  const cleanUpTables = async () => {
    try {
      await sqlDb.query(`DROP TABLE IF EXISTS ${tableName}, ${tableName}_tx`);
    } catch (error) {
      console.error('Error cleaning up Postgres tables', error);
    }
  };
  return {
    db,
    beforeEach: async () => {
      await cleanUpData();
    },
    afterEach: async () => {
      await cleanUpTables();
      await sqlDb.close();
    },
  };
};
