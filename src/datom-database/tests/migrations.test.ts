import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MigrationError } from "../errors.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("Migrations (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("getSchemaVersion", () => {
    test("should return 0 for new database", async () => {
      const { db } = f;
      const version = await db.getSchemaVersion();
      expect(version).toBe(0);
    });

    test("should return current version after migration", async () => {
      const { db } = f;
      await db.migrate(3);
      const version = await db.getSchemaVersion();
      expect(version).toBe(3);
    });

    test("should return updated version after multiple migrations", async () => {
      const { db } = f;
      await db.migrate(1);
      expect(await db.getSchemaVersion()).toBe(1);

      await db.migrate(5);
      expect(await db.getSchemaVersion()).toBe(5);
    });
  });

  describe("migrate", () => {
    test("should migrate to higher version", async () => {
      const { db } = f;
      await db.migrate(2);
      const version = await db.getSchemaVersion();
      expect(version).toBe(2);
    });

    test("should migrate to same version without error", async () => {
      const { db } = f;
      await db.migrate(3);
      await db.migrate(3); // Migrate to same version
      const version = await db.getSchemaVersion();
      expect(version).toBe(3);
    });

    test("should throw MigrationError when attempting backward migration", async () => {
      const { db } = f;
      await db.migrate(5);

      try {
        await db.migrate(3);
        throw new Error("Should have thrown MigrationError");
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        const migrationError = error as MigrationError;
        expect(migrationError.version).toBe(3);
        expect(migrationError.message).toContain("backwards");
        expect(migrationError.code).toBe("MIGRATION_ERROR");
      }
    });

    test("should emit migration event on success", async () => {
      const { db } = f;
      const events: any[] = [];

      const unsubscribe = db.on("migration", (event) => {
        events.push(event);
      });

      await db.migrate(2);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("migration");
      expect(events[0].version).toBe(2);
      expect(events[0].success).toBe(true);
      expect(events[0].error).toBeUndefined();

      unsubscribe();
    });

    test("should emit migration event on failure", async () => {
      const { db } = f;
      await db.migrate(5);

      const events: any[] = [];
      const unsubscribe = db.on("migration", (event) => {
        events.push(event);
      });

      try {
        await db.migrate(3); // Backward migration
      } catch (error) {
        // Expected
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("migration");
      expect(events[0].version).toBe(3);
      expect(events[0].success).toBe(false);
      expect(events[0].error).toBeDefined();

      unsubscribe();
    });
  });
});
