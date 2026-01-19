import { serve } from "bun";
import { unlinkSync } from "fs";
import { FetchHttpClient } from "../../http-client/http-client.js";
import { PgSQLDatabase } from "../../sql-database/sql-database-pg.js";
import { PGLiteSQLDatabase } from "../../sql-database/sql-database-pglite.js";
import { SQLiteSQLDatabase } from "../../sql-database/sql-database-sqlite.js";
import type { DatomDatabase } from "../datom-database.js";
import { HttpClientDatomDatabaseServerComponent } from "../http-client/http-client-datom-database-server-component.js";
import { HttpClientDatomDatabase } from "../http-client/http-client-datom-database.js";
import { InMemoryDatomDatabase } from "../in-memory/in-memory-datom-database.js";
import { PostgreSQLDatomDatabase } from "../postgres/postgres-datom-database.js";
import { SQLiteDatomDatabase } from "../sqlite/sqlite-datom-database.js";

export type Fixture = {
  db: DatomDatabase;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
};

const createInMemoryFixture = async (): Promise<Fixture> => {
  const db = new InMemoryDatomDatabase();
  await db.initialize();
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {},
  };
};

const createSQLiteFixture = async (filename: string): Promise<Fixture> => {
  if (filename !== ":memory:") {
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

const TEST_DATABASE_URL: string =
  "postgresql://postgres:postgres@localhost:5432/postgres";
const createPostgresFixture = async (): Promise<Fixture> => {
  const sqlDb = new PgSQLDatabase(TEST_DATABASE_URL);
  const tableName = "datoms";
  const db = new PostgreSQLDatomDatabase({ sqlDb: sqlDb, tableName });
  await db.initialize();
  const cleanUp = async () => {
    try {
      await sqlDb.execute(`DROP TABLE IF EXISTS ${tableName}, ${tableName}_tx`);
    } catch (error) {
      console.error("Error cleaning up Postgres tables", error);
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

const createPGLiteFixture = async (): Promise<Fixture> => {
  const connection = new PGLiteSQLDatabase("memory://");
  const db = new PostgreSQLDatomDatabase({ sqlDb: connection });
  await db.initialize();
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {},
  };
};

const createHttpClientFixture = async (): Promise<Fixture> => {
  const serverDb = new InMemoryDatomDatabase();
  const transportServerComponent = new HttpClientDatomDatabaseServerComponent(
    serverDb
  );
  const endpoint = `/api/datom-database`;
  const server = serve({
    port: 0, // Let OS assign an available port
    routes: {
      [endpoint]: (request) => transportServerComponent.handleRequest(request),
    },
  });
  // Extract the actual port from the server URL
  const port = parseInt(server.url.port, 10);
  const httpClient = new FetchHttpClient(`http://localhost:${port}`);
  const db = new HttpClientDatomDatabase(httpClient, endpoint);
  await db.initialize();
  return {
    db,
    beforeEach: async () => {
      // Reset the server database state between tests
      await serverDb.close();
      await serverDb.initialize();
      // Also reset t
      // he remote database's initialization state

      await db.initialize();
    },
    afterEach: async () => {
      await server.stop();
    },
  };
};

const TEST_ALL = false;

export const FIXTURES: [string, () => Promise<Fixture>][] = [];
FIXTURES.push(["InMemory", () => createInMemoryFixture()]);
FIXTURES.push(["SQLite (memory)", () => createSQLiteFixture(":memory:")]);
if (TEST_ALL) {
  FIXTURES.push(["SQLite (file)", () => createSQLiteFixture("test.db")]);
}
FIXTURES.push(["PostgreSQL", () => createPostgresFixture()]);
if (TEST_ALL) {
  FIXTURES.push(["PostgreSQL (PGLite)", () => createPGLiteFixture()]);
}
FIXTURES.push(["HTTP Client", () => createHttpClientFixture()]);
