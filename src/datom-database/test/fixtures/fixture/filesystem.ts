import {FileSystemDatomDatabase} from '../../../filesystem/filesystem-datom-database.js';
import type {Fixture} from '../fixture.js';
import {PgSQLDatabase} from '../../../../sql-database/sql-database-pg.js';
import {PostgreSQLDatomDatabase} from '../../../postgres/postgres-datom-database.js';

const TEST_DATABASE_URL: string = 'postgresql://postgres:postgres@localhost:5433/postgres';

export const createFileSystemFixture = async (filePath: string): Promise<Fixture> => {
  // Create a dedicated Postgres instance with a unique table name for this fixture
  const tableName = `datoms_fs_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const sqlDb = new PgSQLDatabase(TEST_DATABASE_URL);
  const postgresDb = new PostgreSQLDatomDatabase({sqlDb, tableName});
  await postgresDb.initialize();

  // Ensure a clean state before database initialization
  try {
    await Bun.file(filePath).delete();
  } catch {
    // File might not exist; ignore
  }

  const db = new FileSystemDatomDatabase({filePath, db: postgresDb});
  await db.initialize();

  const cleanUpPostgresData = async () => {
    try {
      await sqlDb.query(`DELETE FROM ${tableName}`);
      await sqlDb.query(`DELETE FROM ${tableName}_tx`);
      await sqlDb.query(
        `INSERT INTO ${tableName}_tx (id, last_tx) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET last_tx = 0`,
      );
    } catch (error) {
      console.error('Error cleaning up Postgres data', error);
    }
  };

  const cleanUpPostgresTables = async () => {
    try {
      await sqlDb.query(`DROP TABLE IF EXISTS ${tableName}, ${tableName}_tx`);
    } catch (error) {
      console.error('Error cleaning up Postgres tables', error);
    }
  };

  return {
    db,
    beforeEach: async () => {
      // Clean up both the file and the underlying Postgres data
      await cleanUpPostgresData();
      try {
        await Bun.file(filePath).delete();
      } catch {
        // File might not exist; ignore
      }
      await db.initialize();
    },
    afterEach: async () => {
      // Clean up the file and drop the Postgres tables
      try {
        await Bun.file(filePath).delete();
      } catch {
        // File might not exist; ignore
      }
      await cleanUpPostgresTables();
      await sqlDb.close();
    },
  };
};
