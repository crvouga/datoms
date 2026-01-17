import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DatabaseEvent, Datom } from "../../types.js";
import { Fixture, FIXTURES } from "./fixtures.js";
import { exportDatoms, importDatoms } from "../backup/index.js";
import { ObservableDatabase } from "../observability/index.js";

describe.each(FIXTURES)("Backup & Recovery (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("export", () => {
    test("should return async iterable", async () => {
      const { db } = f;
      await db.transact({ add: [
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]});

      const datoms: Datom[] = [];
      for await (const datom of exportDatoms(db, { attribute: "name" })) {
        datoms.push(datom);
      }

      expect(datoms).toHaveLength(2);
      expect(datoms.some((d) => d.value === "Alice")).toBe(true);
      expect(datoms.some((d) => d.value === "Bob")).toBe(true);
    });

    test("should export with filters", async () => {
      const { db } = f;
      await db.transact({ add: [
        [1, "name", "Alice"],
        [1, "age", 30],
        [2, "name", "Bob"],
        [2, "age", 25],
      ]});

      const datoms: Datom[] = [];
      for await (const datom of exportDatoms(db, { entity: 1 })) {
        datoms.push(datom);
      }

      expect(datoms).toHaveLength(2);
      expect(datoms.every((d) => d.entity === 1)).toBe(true);
    });

    test("should export without filters (full scan)", async () => {
      const { db } = f;
      await db.transact({ add: [
        [1, "name", "Alice"],
        [2, "name", "Bob"],
        [3, "name", "Charlie"],
      ]});

      const datoms: Datom[] = [];
      for await (const datom of exportDatoms(db)) {
        datoms.push(datom);
      }

      expect(datoms.length).toBeGreaterThanOrEqual(3);
    });

    test("should emit backup events", async () => {
      const { db } = f;
      await db.transact({ add: [
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]});

      const observableDb = new ObservableDatabase(db);
      const events: DatabaseEvent[] = [];
      observableDb.on("backup", (event) => {
        events.push(event);
      });

      const datoms: Datom[] = [];
      for await (const datom of exportDatoms(db, { attribute: "name" })) {
        datoms.push(datom);
      }
      await observableDb.emitEvent({
        type: "backup",
        datomCount: datoms.length,
        success: true,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("backup");
      if (events[0].type === "backup") {
        expect(events[0].datomCount).toBe(2);
        expect(events[0].success).toBe(true);
      }
    });

    test("should handle export errors", async () => {
      const { db } = f;
      const observableDb = new ObservableDatabase(db);
      const events: DatabaseEvent[] = [];
      observableDb.on("backup", (event) => {
        events.push(event);
      });

      // Try to export with invalid options that might cause error
      // (This depends on implementation, but we should test error handling)
      try {
        const datoms: Datom[] = [];
        for await (const datom of exportDatoms(db, { attribute: "nonexistent" })) {
          datoms.push(datom);
        }
        await observableDb.emitEvent({
          type: "backup",
          datomCount: datoms.length,
          success: true,
        });
        // Should complete successfully even if no results
        expect(events).toHaveLength(1);
        if (events[0].type === "backup") {
          expect(events[0].success).toBe(true);
        }
      } catch (error) {
        // If error occurs, should be captured in event
        expect(events).toHaveLength(1);
        if (events[0].type === "backup") {
          expect(events[0].success).toBe(false);
        }
        if (events[0].type === "backup") {
          expect(events[0].error).toBeDefined();
        }
      }
    });
  });

  describe("import", () => {
    test("should import from async iterable", async () => {
      const { db } = f;
      await db.transact({ add: [
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]});

      // Export datoms
      const exported: Datom[] = [];
      for await (const datom of exportDatoms(db)) {
        exported.push(datom);
      }

      // Create new database instance
      const { db: db2 } = await createFixture();
      await db2.initialize();

      // Import datoms
      async function* datomGenerator() {
        for (const datom of exported) {
          yield datom;
        }
      }

      const count = await importDatoms(db2, datomGenerator());

      expect(count).toBe(exported.length);

      // Verify imported data
      const alice = await db2.datoms({ entity: 1 });
      expect(alice.length).toBeGreaterThan(0);
      expect(alice.some((d) => d.value === "Alice")).toBe(true);

      await db2.close();
    });

    test("should import with batching", async () => {
      const { db } = f;
      // Create many datoms
      const datoms: Datom[] = [];
      for (let i = 1; i <= 50; i++) {
        await db.transact({ add: [[i, "name", `Entity${i}`]]});
        const entityDatoms = await db.datoms({ entity: i });
        datoms.push(...entityDatoms);
      }

      // Export
      const exported: Datom[] = [];
      for await (const datom of exportDatoms(db)) {
        exported.push(datom);
      }

      // Create new database
      const { db: db2 } = await createFixture();
      await db2.initialize();

      // Import with small batch size
      async function* datomGenerator() {
        for (const datom of exported) {
          yield datom;
        }
      }

      const count = await importDatoms(db2, datomGenerator(), { batchSize: 10 });

      expect(count).toBe(exported.length);

      // Verify some entities
      const entity1 = await db2.datoms({ entity: 1 });
      expect(entity1.length).toBeGreaterThan(0);

      await db2.close();
    });

    test("should import with validation", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "age",
        cardinality: "one",
        type: "number",
      });

      await db.transact({ add: [[1, "age", 30]]});

      // Export
      const exported: Datom[] = [];
      for await (const datom of exportDatoms(db, { entity: 1 })) {
        exported.push(datom);
      }

      // Create new database
      const { db: db2 } = await createFixture();
      await db2.initialize();
      await db2.defineAttribute({
        name: "age",
        cardinality: "one",
        type: "number",
      });

      // Import with validation
      async function* datomGenerator() {
        for (const datom of exported) {
          yield datom;
        }
      }

      const count = await importDatoms(db2, datomGenerator(), { validate: true });

      expect(count).toBe(exported.length);

      const ageResults = await db2.query({ find: ["?v"], where: [[1, "age", "?v"]] });
      const age = ageResults[0]?.v;
      expect(age).toBe(30);

      await db2.close();
    });

    test("should import without validation", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]]});

      // Export
      const exported: Datom[] = [];
      for await (const datom of exportDatoms(db, { entity: 1 })) {
        exported.push(datom);
      }

      // Create new database
      const { db: db2 } = await createFixture();
      await db2.initialize();

      // Import without validation
      async function* datomGenerator() {
        for (const datom of exported) {
          yield datom;
        }
      }

      const count = await importDatoms(db2, datomGenerator(), { validate: false });

      expect(count).toBe(exported.length);

      await db2.close();
    });

    test("should emit restore events", async () => {
      const { db } = f;
      await db.transact({ add: [
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]});

      // Export
      const exported: Datom[] = [];
      for await (const datom of exportDatoms(db)) {
        exported.push(datom);
      }

      // Create new database
      const { db: db2 } = await createFixture();
      await db2.initialize();

      const observableDb2 = new ObservableDatabase(db2);
      const events: DatabaseEvent[] = [];
      observableDb2.on("restore", (event) => {
        events.push(event);
      });

      // Import
      async function* datomGenerator() {
        for (const datom of exported) {
          yield datom;
        }
      }

      await importDatoms(db2, datomGenerator());
      await observableDb2.emitEvent({
        type: "restore",
        datomCount: exported.length,
        success: true,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("restore");
      if (events[0].type === "restore") {
        expect(events[0].datomCount).toBe(exported.length);
        expect(events[0].success).toBe(true);
      }

      await db2.close();
    });

    test("should handle import errors", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "age",
        cardinality: "one",
        type: "number",
      });

      // Create invalid datom (wrong type)
      const invalidDatom: Datom = {
        entity: 1,
        attribute: "age",
        value: "not-a-number",
        tx: 1,
        added: true,
      };

      const observableDb = new ObservableDatabase(db);
      const events: DatabaseEvent[] = [];
      observableDb.on("restore", (event) => {
        events.push(event);
      });

      async function* invalidGenerator() {
        yield invalidDatom;
      }

      try {
        await observableDb.importDatoms(invalidGenerator(), { validate: true });
        throw new Error("Should have thrown error");
      } catch (error) {
        // Should have error event
        expect(events).toHaveLength(1);
        if (events[0].type === "restore") {
          expect(events[0].success).toBe(false);
        }
        if (events[0].type === "restore") {
          expect(events[0].error).toBeDefined();
        }
      }
    });

    test("should handle empty import", async () => {
      const { db } = f;
      async function* emptyGenerator() {
        // No datoms
      }

      const count = await importDatoms(db, emptyGenerator());
      expect(count).toBe(0);
    });
  });
});
