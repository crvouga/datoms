import type { Fixture } from "../fixture.js";
import { PGLiteSQLDatabase } from "../../../../sql-database/sql-database-pglite.js";
import { PostgreSQLDatomDatabase } from "../../../postgres/postgres-datom-database.js";

export const createPGLiteFixture = async (): Promise<Fixture> => {
  const connection = new PGLiteSQLDatabase("memory://");
  const db = new PostgreSQLDatomDatabase({ sqlDb: connection });
  await db.initialize();
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {},
  };
};
