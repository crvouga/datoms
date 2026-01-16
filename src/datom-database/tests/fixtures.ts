import { unlinkSync } from "fs";
import { PgSQLDatabase } from "../../sql-database/__tests__/sql-database-pg.js";
import { PGLiteSQLDatabase } from "../../sql-database/__tests__/sql-database-pglite.js";
import { SQLiteSQLDatabase } from "../../sql-database/__tests__/sql-database-sqlite.js";
import { PostgreSQLDatomDatabase } from "..//datom-database-postgres.js";
import { InMemoryDatomDatabase } from "../datom-database-in-memory.js";
import { SQLiteDatomDatabase } from "../datom-database-sqlite.js";
import { DatomDatabase } from "../datom-database.js";

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
    } catch {}
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
    afterEach: async () => {},
  };
};

const createPGLiteFixture = async (): Promise<Fixture> => {
  const connection = new PGLiteSQLDatabase("memory://");
  const db = new PostgreSQLDatomDatabase(connection);
  await db.initialize();
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {},
  };
};

export const FIXTURES: [string, () => Promise<Fixture>][] = [
  ["InMemory", () => createInMemoryFixture()],
  ["SQLite (memory)", () => createSQLiteFixture(":memory:")],
  ["SQLite (file)", () => createSQLiteFixture("test.db")],
  ["PostgreSQL", () => createPostgresFixture()],
  ["PostgreSQL (PGLite)", () => createPGLiteFixture()],
];
