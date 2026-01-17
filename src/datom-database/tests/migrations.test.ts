import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MigrationError, MigrationRollbackError } from "../errors.js";
import type { DatabaseEvent, Migration } from "../../types.js";
import { Fixture, FIXTURES } from "./fixtures.js";
import { ObservableDatabase } from "../observability/index.js";

describe.each(FIXTURES)("Migrations (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("migrate", () => {
    test("should migrate to higher version", async () => {
      const { db } = f;
      await db.migrate(2);
      // Migration should complete without error
      expect(true).toBe(true);
    });

    test("should migrate to same version without error", async () => {
      const { db } = f;
      await db.migrate(3);
      await db.migrate(3); // Migrate to same version
      // Should complete without error
      expect(true).toBe(true);
    });

    test("should emit migration event on success", async () => {
      const { db } = f;
      const events: DatabaseEvent[] = [];

      const observableDb = new ObservableDatabase(db);
      const unsubscribe = observableDb.on("migration", (event) => {
        events.push(event);
      });

      await observableDb.migrate(2);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("migration");
      if (events[0].type === "migration") {
        expect(events[0].version).toBe(2);
        expect(events[0].success).toBe(true);
        expect(events[0].error).toBeUndefined();
      }

      unsubscribe();
    });

    test("should emit migration event on failure", async () => {
      const { db } = f;
      await db.migrate(5);

      const events: DatabaseEvent[] = [];
      const observableDb = new ObservableDatabase(db);
      const unsubscribe = observableDb.on("migration", (event) => {
        events.push(event);
      });

      try {
        await observableDb.migrate(3); // Backward migration
      } catch (error) {
        // Expected
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("migration");
      if (events[0].type === "migration") {
        expect(events[0].version).toBe(3);
        expect(events[0].success).toBe(false);
        expect(events[0].error).toBeDefined();
      }

      unsubscribe();
    });
  });

  describe("Migration Framework", () => {
    test("should register and execute migrations", async () => {
      const { db } = f;
      let migration1Executed = false;
      let migration2Executed = false;

      const migration1: Migration = {
        version: 1,
        name: "migration1",
        up: async () => {
          migration1Executed = true;
        },
        down: async () => {},
      };

      const migration2: Migration = {
        version: 2,
        name: "migration2",
        up: async () => {
          migration2Executed = true;
        },
        down: async () => {},
      };

      db.registerMigration(migration1);
      db.registerMigration(migration2);

      await db.migrateTo(2);

      expect(migration1Executed).toBe(true);
      expect(migration2Executed).toBe(true);
    });

    test("should execute migrations in order", async () => {
      const { db } = f;
      const executionOrder: number[] = [];

      const migration1: Migration = {
        version: 1,
        name: "migration1",
        up: async () => {
          executionOrder.push(1);
        },
        down: async () => {},
      };

      const migration2: Migration = {
        version: 2,
        name: "migration2",
        up: async () => {
          executionOrder.push(2);
        },
        down: async () => {},
      };

      const migration3: Migration = {
        version: 3,
        name: "migration3",
        up: async () => {
          executionOrder.push(3);
        },
        down: async () => {},
      };

      // Register out of order
      db.registerMigration(migration3);
      db.registerMigration(migration1);
      db.registerMigration(migration2);

      await db.migrateTo(3);

      expect(executionOrder).toEqual([1, 2, 3]);
    });

    test("should rollback migrations", async () => {
      const { db } = f;
      let rollbackExecuted = false;

      const migration: Migration = {
        version: 1,
        name: "migration1",
        up: async () => {
          // Migration logic here
        },
        down: async () => {
          rollbackExecuted = true;
        },
      };

      db.registerMigration(migration);
      await db.migrateTo(1);

      await db.rollbackTo(0);

      expect(rollbackExecuted).toBe(true);
    });

    test("should rollback multiple migrations in reverse order", async () => {
      const { db } = f;
      const rollbackOrder: number[] = [];

      const migration1: Migration = {
        version: 1,
        name: "migration1",
        up: async () => {},
        down: async () => {
          rollbackOrder.push(1);
        },
      };

      const migration2: Migration = {
        version: 2,
        name: "migration2",
        up: async () => {},
        down: async () => {
          rollbackOrder.push(2);
        },
      };

      db.registerMigration(migration1);
      db.registerMigration(migration2);

      await db.migrateTo(2);
      await db.rollbackTo(0);

      expect(rollbackOrder).toEqual([2, 1]);
    });

    test("should throw MigrationRollbackError on rollback failure", async () => {
      const { db } = f;
      const migration: Migration = {
        version: 1,
        name: "failing_migration",
        up: async () => {},
        down: async () => {
          throw new Error("Rollback failed");
        },
      };

      db.registerMigration(migration);
      await db.migrateTo(1);

      try {
        await db.rollbackTo(0);
        throw new Error("Should have thrown MigrationRollbackError");
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationRollbackError);
        const rollbackError = error as MigrationRollbackError;
        expect(rollbackError.version).toBe(1);
        expect(rollbackError.code).toBe("MIGRATION_ROLLBACK_ERROR");
      }
    });

    test("should not execute already applied migrations", async () => {
      const { db } = f;
      let executionCount = 0;

      const migration: Migration = {
        version: 1,
        name: "migration1",
        up: async () => {
          executionCount++;
        },
        down: async () => {},
      };

      db.registerMigration(migration);

      await db.migrateTo(1);
      expect(executionCount).toBe(1);

      // Migrate to same version again
      await db.migrateTo(1);
      expect(executionCount).toBe(1); // Should not execute again
    });

    test("should register multiple migrations at once", async () => {
      const { db } = f;
      const migrations: Migration[] = [
        {
          version: 1,
          name: "migration1",
          up: async () => {},
          down: async () => {},
        },
        {
          version: 2,
          name: "migration2",
          up: async () => {},
          down: async () => {},
        },
      ];

      db.registerMigrations(migrations);
      await db.migrateTo(2);
      // Migration should complete without error
      expect(true).toBe(true);
    });

    test("should throw error when registering duplicate version", () => {
      const { db } = f;
      const migration: Migration = {
        version: 1,
        name: "migration1",
        up: async () => {},
        down: async () => {},
      };

      db.registerMigration(migration);

      try {
        db.registerMigration(migration);
        throw new Error("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("already registered");
      }
    });
  });
});
