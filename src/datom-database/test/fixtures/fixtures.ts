import type { Fixture } from "./fixture.js";
import { createFileSystemFixture } from "./fixture/filesystem.js";
import { createHttpClientFixture } from "./fixture/http-client.js";
import { createInMemoryFixture } from "./fixture/in-memory.js";
import { createPGLiteFixture } from "./fixture/pglite.js";
import { createPostgresFixture } from "./fixture/postgres.js";
import { createSQLiteFixture } from "./fixture/sqlite.js";

const FAST_TESTS = process.env["FAST_TESTS"] === "true";

export const FIXTURES: [string, () => Promise<Fixture>][] = [];
FIXTURES.push(["InMemory", () => createInMemoryFixture()]);
FIXTURES.push(["SQLite (memory)", () => createSQLiteFixture(":memory:")]);
FIXTURES.push(["PostgreSQL", () => createPostgresFixture()]);
if (FAST_TESTS) {
  console.log("FAST_TESTS is true. Skipping slow tests...");
} else {
  FIXTURES.push(["HTTP Client", () => createHttpClientFixture()]);
  FIXTURES.push(["SQLite (file)", () => createSQLiteFixture("test.db")]);
  FIXTURES.push(["PostgreSQL (PGLite)", () => createPGLiteFixture()]);
  FIXTURES.push(["FileSystem", () => createFileSystemFixture()]);
}
