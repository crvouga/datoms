import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fixture, FIXTURES } from "./fixtures.js";
import { DatabaseEvent } from "../../types.js";

describe.each(FIXTURES)("Observability (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Events", () => {
    test("should register event listener and return unsubscribe function", async () => {
      const { db } = f;
      const events: DatabaseEvent[] = [];

      const unsubscribe = db.on("transaction", (event) => {
        events.push(event);
      });

      // Use transact() which emits transaction events (add() doesn't emit events)
      await db.transact({ add: [[1, "name", "Alice"]] });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("transaction");

      // Unsubscribe
      unsubscribe();

      await db.transact({ add: [[2, "name", "Bob"]] });
      // Should not have new event
      expect(events).toHaveLength(1);
    });

    test("should emit transaction events", async () => {
      const { db } = f;
      const events: DatabaseEvent[] = [];

      db.on("transaction", (event) => {
        events.push(event);
      });

      // Use transact() which emits transaction events
      const txId = await db.transact({ add: [[1, "name", "Alice"]] });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("transaction");
      if (events[0].type === "transaction") {
        expect(events[0].txId).toBe(txId);
        expect(events[0].addedCount).toBe(1);
        expect(events[0].retractedCount).toBe(0);
      }
    });

    test("should emit transaction events with metadata", async () => {
      const { db } = f;
      const events: DatabaseEvent[] = [];

      db.on("transaction", (event) => {
        events.push(event);
      });

      await db.transact(
        { add: [[1, "name", "Alice"]] },
        { userId: "alice", reason: "test" }
      );

      expect(events).toHaveLength(1);
      if (events[0].type === "transaction") {
        expect(events[0].metadata).toEqual({ userId: "alice", reason: "test" });
      }
    });

    test("should emit query events", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      const events: DatabaseEvent[] = [];
      db.on("query", (event) => {
        events.push(event);
      });

      await db.query({ entity: 1 });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("query");
      if (events[0].type === "query") {
        expect(events[0].options).toEqual({ entity: 1 });
        expect(events[0].resultCount).toBe(1);
        expect(typeof events[0].duration).toBe("number");
      }
    });

    test("should emit error events", async () => {
      const { db } = f;
      const events: DatabaseEvent[] = [];

      db.on("error", (event) => {
        events.push(event);
      });

      try {
        await db.query({}); // Should throw QuerySafetyError
      } catch (error) {
        // Expected
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].error).toBeInstanceOf(Error);
        expect(events[0].context).toBeDefined();
      }
    });

    test("should emit migration events", async () => {
      const { db } = f;
      const events: DatabaseEvent[] = [];

      db.on("migration", (event) => {
        events.push(event);
      });

      await db.migrate(2);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("migration");
      if (events[0].type === "migration") {
        expect(events[0].version).toBe(2);
        expect(events[0].success).toBe(true);
      }
    });

    test("should emit backup events", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]);

      const events: DatabaseEvent[] = [];
      db.on("backup", (event) => {
        events.push(event);
      });

      const datoms: any[] = [];
      for await (const datom of db.export({ attribute: "name" })) {
        datoms.push(datom);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("backup");
      if (events[0].type === "backup") {
        expect(events[0].datomCount).toBe(2);
        expect(events[0].success).toBe(true);
      }
    });

    test("should emit restore events", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      const events: DatabaseEvent[] = [];
      db.on("restore", (event) => {
        events.push(event);
      });

      // Export and import
      const exported: any[] = [];
      for await (const datom of db.export({ entity: 1 })) {
        exported.push(datom);
      }

      // Create new database instance for import
      const { db: db2 } = await createFixture();
      await db2.initialize();

      const events2: any[] = [];
      db2.on("restore", (event) => {
        events2.push(event);
      });

      async function* datomGenerator() {
        for (const datom of exported) {
          yield datom;
        }
      }

      const count = await db2.import(datomGenerator());

      expect(count).toBe(exported.length);
      expect(events2).toHaveLength(1);
      expect(events2[0].type).toBe("restore");
      expect(events2[0].datomCount).toBe(exported.length);
      expect(events2[0].success).toBe(true);

      await db2.close();
    });

    test("should handle listener errors gracefully", async () => {
      const { db } = f;
      const errorEvents: DatabaseEvent[] = [];

      // Register a listener that throws
      db.on("transaction", () => {
        throw new Error("Listener error");
      });

      // Register error listener
      db.on("error", (event) => {
        errorEvents.push(event);
      });

      // Use transact() which emits transaction events
      await db.transact({ add: [[1, "name", "Alice"]] });

      // Should have error event from listener failure
      expect(errorEvents.length).toBeGreaterThan(0);

      const listenerError = errorEvents.find(
        (e) => e.type === "error" && e.context?.eventType === "transaction"
      );

      if (listenerError?.type === "error") {
        expect(listenerError.error).toBeDefined();
        expect(listenerError.error.message).toBe("Listener error");
      }
    });

    test("should support multiple listeners for same event type", async () => {
      const { db } = f;
      const events1: any[] = [];
      const events2: any[] = [];

      db.on("transaction", (event) => {
        events1.push(event);
      });

      db.on("transaction", (event) => {
        events2.push(event);
      });

      // Use transact() which emits transaction events
      await db.transact({ add: [[1, "name", "Alice"]] });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });
  });

  describe("Stats", () => {
    test("should return basic stats", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      const stats = await db.getStats();

      expect(stats).toBeDefined();
      expect(stats.latestTransaction).toBeGreaterThan(0);
      expect(stats.totalTransactions).toBe(stats.latestTransaction);
      expect(stats.schemaAttributeCount).toBe(0);
    });

    test("should include schema attribute count", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "name",
        cardinality: "one",
        type: "string",
      });
      await db.defineAttribute({
        name: "age",
        cardinality: "one",
        type: "number",
      });

      const stats = await db.getStats();

      expect(stats.schemaAttributeCount).toBe(2);
    });

    test("should track query metrics", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]);

      // Perform some queries
      await db.query({ entity: 1 });
      await db.query({ entity: 2 });
      await db.query({ attribute: "name" });

      const stats = await db.getStats();

      expect(stats.queryMetrics).toBeDefined();
      expect(stats.queryMetrics?.totalQueries).toBe(3);
      expect(stats.queryMetrics?.averageQueryTime).toBeGreaterThanOrEqual(0);
    });

    test("should track transaction metrics", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      await db.add([[2, "name", "Bob"]]);
      await db.transact({
        add: [[3, "name", "Charlie"]],
        retract: [[1, "name", "Alice"]],
      });

      const stats = await db.getStats();

      expect(stats.transactionMetrics).toBeDefined();
      expect(
        stats.transactionMetrics?.averageTransactionTime
      ).toBeGreaterThanOrEqual(0);
    });

    test("should include latest transaction in stats", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.add([[2, "name", "Bob"]]);

      const stats = await db.getStats();

      expect(stats.latestTransaction).toBe(tx2);
      expect(stats.totalTransactions).toBe(tx2);
    });
  });

  describe("Logging Integration", () => {
    test("should log events when logger is set", async () => {
      const { db } = f;
      const logMessages: Array<{
        level: string;
        message: string;
        meta?: unknown;
      }> = [];

      const logger = {
        debug: (message: string, meta?: unknown) => {
          logMessages.push({ level: "debug", message, meta });
        },
        info: (message: string, meta?: unknown) => {
          logMessages.push({ level: "info", message, meta });
        },
        warn: (message: string, meta?: unknown) => {
          logMessages.push({ level: "warn", message, meta });
        },
        error: (message: string, meta?: unknown) => {
          logMessages.push({ level: "error", message, meta });
        },
      };

      db.setLogger(logger);

      await db.transact({ add: [[1, "name", "Alice"]] });
      await db.query({ entity: 1 });

      // Should have logged transaction and query events
      expect(logMessages.length).toBeGreaterThan(0);
      const transactionLog = logMessages.find((m) =>
        m.message.includes("transaction")
      );
      expect(transactionLog).toBeDefined();
      if (transactionLog) {
        expect(transactionLog.level).toBe("info");
        expect(transactionLog.meta).toBeDefined();
      }
    });

    test("should log error events at error level", async () => {
      const { db } = f;
      const errorLogs: Array<{ level: string; message: string }> = [];

      const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message: string) => {
          errorLogs.push({ level: "error", message });
        },
      };

      db.setLogger(logger);

      try {
        await db.query({}); // Should throw QuerySafetyError
      } catch {
        // Expected
      }

      // Should have logged error event
      expect(errorLogs.length).toBeGreaterThan(0);
      const errorLog = errorLogs.find((m) => m.message.includes("error"));
      expect(errorLog).toBeDefined();
      if (errorLog) {
        expect(errorLog.level).toBe("error");
      }
    });

    test("should log query events at debug level", async () => {
      const { db } = f;
      const debugLogs: Array<{ level: string; message: string }> = [];

      const logger = {
        debug: (message: string) => {
          debugLogs.push({ level: "debug", message });
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      db.setLogger(logger);
      await db.add([[1, "name", "Alice"]]);
      await db.query({ entity: 1 });

      // Should have logged query event at debug level
      const queryLog = debugLogs.find((m) => m.message.includes("query"));
      expect(queryLog).toBeDefined();
      if (queryLog) {
        expect(queryLog.level).toBe("debug");
      }
    });

    test("should work without logger", async () => {
      const { db } = f;
      // Should not throw when no logger is set
      await db.transact({ add: [[1, "name", "Alice"]] });
      await db.query({ entity: 1 });
    });
  });
});
