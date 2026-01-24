import {FileSystemDatomDatabase} from '../../../filesystem/filesystem-datom-database.js';
import type {Fixture} from '../fixture.js';
import {createPostgresFixture} from './postgres.js';

export const createFileSystemFixture = async (filePath: string): Promise<Fixture> => {
  const postgresFixture = await createPostgresFixture();
  // Ensure a clean state before database initialization
  try {
    await Bun.file(filePath).delete();
  } catch {
    // File might not exist; ignore
  }

  const db = new FileSystemDatomDatabase({filePath, db: postgresFixture.db});
  await db.initialize();

  return {
    db,
    beforeEach: async () => {
      // Clean up the underlying Postgres DB data (not tables/connections)
      await postgresFixture.beforeEach();
      // Delete the file
      try {
        await Bun.file(filePath).delete();
      } catch {
        // File might not exist; ignore
      }
      // Re-initialize the FileSystem DB (reloads from empty state)
      await db.initialize();
    },
    afterEach: async () => {
      // Just clean up the file - don't close Postgres connection yet
      // as it may be needed for other tests
      try {
        await Bun.file(filePath).delete();
      } catch {
        // File might not exist; ignore
      }
    },
  };
};
