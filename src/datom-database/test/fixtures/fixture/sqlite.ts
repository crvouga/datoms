import {unlinkSync} from 'fs';
import type {Fixture} from '../fixture.js';
import {SQLiteSQLDatabase} from '../../../../sql-database/sql-database-sqlite.js';
import {SQLiteDatomDatabase} from '../../../sqlite/sqlite-datom-database.js';

export const createSQLiteFixture = async (filename: string): Promise<Fixture> => {
  if (filename !== ':memory:') {
    try {
      unlinkSync(filename);
    } catch {
      // File doesn't exist, which is fine
    }
  }
  const connection = new SQLiteSQLDatabase(filename);
  const db = new SQLiteDatomDatabase(connection);
  await db.initialize();
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {},
  };
};
