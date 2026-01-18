import { unlinkSync } from "fs";
import { PgSQLDatabase } from "../../sql-database/sql-database-pg.js";
import { PGLiteSQLDatabase } from "../../sql-database/sql-database-pglite.js";
import { SQLiteSQLDatabase } from "../../sql-database/sql-database-sqlite.js";
import type { DatomDatabase } from "../datom-database.js";
import { InMemoryDatomDatabase } from "../in-memory/in-memory-datom-database.js";
import { PostgreSQLDatomDatabase } from "../postgres/postgres-datom-database.js";
import { RemoteDatomDatabase } from "../remote/datom-database-remote.js";
import { LocalTransport } from "../remote/transport/local-transport.js";
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
    beforeEach: async () => { },
    afterEach: async () => { },
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
    beforeEach: async () => { },
    afterEach: async () => { },
  };
};

const createPostgresFixture = async (): Promise<Fixture> => {
  const connectionString =
    "postgresql://datoms:datoms@localhost:5432/datoms_test";
  const connection = new PgSQLDatabase(connectionString);
  const db = new PostgreSQLDatomDatabase(connection);
  await db.initialize();
  return {
    db,
    beforeEach: async () => {
      // @ts-expect-error - Accessing protected method for test cleanup
      await db.cleanUp();
    },
    afterEach: async () => {
      // Ensure connection is properly closed/released after each test
      await db.close();
    },
  };
};

const createPGLiteFixture = async (): Promise<Fixture> => {
  const connection = new PGLiteSQLDatabase("memory://");
  const db = new PostgreSQLDatomDatabase(connection);
  await db.initialize();
  return {
    db,
    beforeEach: async () => { },
    afterEach: async () => { },
  };
};

const createRemoteFixture = async (): Promise<Fixture> => {
  const transport = new LocalTransport(new InMemoryDatomDatabase());
  const db = new RemoteDatomDatabase(transport);
  await db.initialize();
  return {
    db,
    beforeEach: async () => { },
    afterEach: async () => {
      await db.close();
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
FIXTURES.push(["Remote", () => createRemoteFixture()]);
