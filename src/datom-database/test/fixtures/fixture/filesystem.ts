import type {Fixture} from '../fixture.js';
import {FileSystemDatomDatabase} from '../../../filesystem/filesystem-datom-database.js';

export const createFileSystemFixture = async (filePath: string): Promise<Fixture> => {
  // Ensure a clean state before database initialization
  try {
    await Bun.file(filePath).delete();
  } catch {
    // File might not exist; ignore
  }

  const db = new FileSystemDatomDatabase({filePath});
  await db.initialize();

  return {
    db,
    beforeEach: async () => {
      // Before each test, delete the file and re-initialize DB
      try {
        await Bun.file(filePath).delete();
      } catch {
        // File might not exist; ignore
      }
      await db.initialize();
    },
    afterEach: async () => {
      // Data is already persisted via auto-persist
      try {
        await Bun.file(filePath).delete();
      } catch {
        // File might not exist; ignore
      }
    },
  };
};
