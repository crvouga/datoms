import type { Fixture } from "../fixture.js";
import { FileSystemDatomDatabase } from "../../../filesystem/filesystem-datom-database.js";

export const createFileSystemFixture = async (): Promise<Fixture> => {
  const FILE_PATH = "test.csv";

  // Ensure a clean state before database initialization
  try {
    await Bun.file(FILE_PATH).delete();
  } catch {
    // File might not exist; ignore
  }

  const db = new FileSystemDatomDatabase({ filePath: FILE_PATH });
  await db.initialize();

  return {
    db,
    beforeEach: async () => {
      // Before each test, delete the file and re-initialize DB
      try {
        await Bun.file(FILE_PATH).delete();
      } catch {
        // File might not exist; ignore
      }
      await db.initialize();
    },
    afterEach: async () => {
      // After each test, close DB and remove the test file
      await db.close();
      try {
        await Bun.file(FILE_PATH).delete();
      } catch {
        // File might not exist; ignore
      }
    },
  };
};
