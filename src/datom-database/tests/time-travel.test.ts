import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DatalogQuery } from "../../datalog/datalog.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("DatomDatabase (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Time-Traveling Queries", () => {
    test("should query database state at specific transaction ID", async () => {
      const { db } = f;
      // Add datoms in sequence
      const tx1 = await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.add([[1, "age", 30]]);
      const tx3 = await db.add([[1, "name", "Alice Updated"]]);

      // Query at tx1 - should only see name
      const atTx1 = await db.datoms({ asOf: tx1, entity: 1 });
      expect(atTx1).toHaveLength(1);
      expect(atTx1[0].attribute).toBe("name");
      expect(atTx1[0].value).toBe("Alice");

      // Query at tx2 - should see name and age
      const atTx2 = await db.datoms({ asOf: tx2, entity: 1 });
      expect(atTx2).toHaveLength(2);
      const valuesAtTx2 = atTx2.map((d) => d.value).sort();
      expect(valuesAtTx2).toContain("Alice");
      expect(valuesAtTx2).toContain(30);

      // Query at tx3 - should see updated name and age
      const atTx3 = await db.datoms({ asOf: tx3, entity: 1 });
      expect(atTx3).toHaveLength(2);
      const nameAtTx3 = atTx3.find((d) => d.attribute === "name");
      expect(nameAtTx3?.value).toBe("Alice Updated");

      await db.close();
    });

    test("should handle retractions in time-travel queries", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.add([[1, "age", 30]]);
      const tx3 = await db.retract([[1, "age", 30]]);

      // Query at tx2 - should see both name and age
      const atTx2 = await db.datoms({ asOf: tx2, entity: 1 });
      expect(atTx2).toHaveLength(2);

      // Query at tx3 - should only see name (age was retracted)
      const atTx3 = await db.datoms({ asOf: tx3, entity: 1 });
      expect(atTx3).toHaveLength(1);
      expect(atTx3[0].attribute).toBe("name");

      await db.close();
    });

    test("should query full history of changes", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      await db.add([[1, "name", "Alice Updated"]]);
      await db.add([[1, "age", 30]]);

      // Query history - should return all changes
      const history = await db.queryHistory({ entity: 1, attribute: "name" });
      expect(history.length).toBeGreaterThanOrEqual(2);
      // Should include both the original and updated name
      const names = history.map((d) => d.value);
      expect(names).toContain("Alice");
      expect(names).toContain("Alice Updated");

      await db.close();
    });

    test("should get entity at specific transaction", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.add([[1, "age", 30]]);

      const entityAtTx1 = await db.getEntityAsOf(1, tx1);
      expect(entityAtTx1).toHaveLength(1);
      expect(entityAtTx1[0].attribute).toBe("name");

      const entityAtTx2 = await db.getEntityAsOf(1, tx2);
      expect(entityAtTx2).toHaveLength(2);

      await db.close();
    });

    test("should get value at specific transaction", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "name", "Alice"]]);
      await db.add([[1, "name", "Bob"]]);

      const nameAtTx1 = await db.getValueAsOf(1, "name", tx1);
      expect(nameAtTx1).toBe("Alice");

      await db.close();
    });

    test("should support time-travel in datalog queries", async () => {
      const { db } = f;
      const tx1 = await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]);
      const tx2 = await db.add([[3, "name", "Charlie"]]);

      // Query at tx1 - should only see Alice and Bob
      const queryAtTx1: DatalogQuery = {
        find: ["?name"],
        where: [["?e", "name", "?name"]],
        asOf: tx1,
      };
      const resultsAtTx1 = await db.queryDatalog(queryAtTx1);
      expect(resultsAtTx1).toHaveLength(2);
      const namesAtTx1 = resultsAtTx1.map((r) => r["name"]).sort();
      expect(namesAtTx1).toEqual(["Alice", "Bob"]);

      // Query at tx2 - should see all three
      const queryAtTx2: DatalogQuery = {
        find: ["?name"],
        where: [["?e", "name", "?name"]],
        asOf: tx2,
      };
      const resultsAtTx2 = await db.queryDatalog(queryAtTx2);
      expect(resultsAtTx2).toHaveLength(3);
      const namesAtTx2 = resultsAtTx2.map((r) => r["name"]).sort();
      expect(namesAtTx2).toEqual(["Alice", "Bob", "Charlie"]);

      await db.close();
    });

    test("should handle time-travel queries within transactions", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        // Add new datom in transaction
        await tx.add([[1, "age", 30]]);

        // Query current state - should see uncommitted age
        const current = await tx.datoms({ entity: 1 });
        expect(current).toHaveLength(2);

        // Query at tx1 - should only see committed name (not uncommitted age)
        const atTx1 = await tx.datoms({ asOf: tx1, entity: 1 });
        expect(atTx1).toHaveLength(1);
        expect(atTx1[0].attribute).toBe("name");
      });

      await db.close();
    });

    test("should handle complex time-travel scenario", async () => {
      const { db } = f;
      // Create a timeline of changes
      const tx1 = await db.add([[1, "status", "pending"]]);
      const tx2 = await db.add([[1, "status", "processing"]]);
      const tx3 = await db.add([[1, "status", "completed"]]);
      const tx4 = await db.retract([[1, "status", "completed"]]);
      const tx5 = await db.add([[1, "status", "failed"]]);

      // Verify state at each transaction
      const atTx1 = await db.getValueAsOf(1, "status", tx1);
      expect(atTx1).toBe("pending");

      const atTx2 = await db.getValueAsOf(1, "status", tx2);
      expect(atTx2).toBe("processing");

      const atTx3 = await db.getValueAsOf(1, "status", tx3);
      expect(atTx3).toBe("completed");

      // At tx4, status was retracted, so should return undefined
      const atTx4 = await db.getValueAsOf(1, "status", tx4);
      expect(atTx4).toBeUndefined();

      // At tx5, status is failed
      const atTx5 = await db.getValueAsOf(1, "status", tx5);
      expect(atTx5).toBe("failed");

      // Current state should also be failed
      const current = await db.getValue(1, "status");
      expect(current).toBe("failed");

      await db.close();
    });

    test("should retract all datoms for an entity", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [1, "age", 30],
        [1, "email", "alice@example.com"],
      ]);

      const before = await db.getEntity(1);
      expect(before).toHaveLength(3);

      const tx = await db.retractEntity(1);

      const after = await db.getEntity(1);
      expect(after).toHaveLength(0);

      // Verify transaction ID was returned
      expect(typeof tx).toBe("number");
      expect(tx).toBeGreaterThan(0);

      await db.close();
    });

    test("should retract entity within transaction", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [1, "age", 30],
      ]);

      await db.transaction(async (tx) => {
        await tx.retractEntity(1);
        const during = await tx.getEntity(1);
        expect(during).toHaveLength(0);
      });

      const after = await db.getEntity(1);
      expect(after).toHaveLength(0);

      await db.close();
    });

    test("should execute bulk operations atomically with transact", async () => {
      const { db } = f;
      const tx = await db.transact({
        add: [
          [1, "name", "Alice"],
          [2, "name", "Bob"],
        ],
        retract: [[3, "name", "Charlie"]],
      });

      expect(typeof tx).toBe("number");
      expect(tx).toBeGreaterThan(0);

      const alice = await db.getEntity(1);
      expect(alice).toHaveLength(1);
      expect(alice[0].value).toBe("Alice");

      const bob = await db.getEntity(2);
      expect(bob).toHaveLength(1);
      expect(bob[0].value).toBe("Bob");

      // Charlie should not exist (or was retracted if existed)
      const charlie = await db.getEntity(3);
      expect(charlie).toHaveLength(0);

      await db.close();
    });

    test("should execute bulk operations within transaction", async () => {
      const { db } = f;
      await db.transaction(async (tx) => {
        await tx.transact({
          add: [
            [1, "name", "Alice"],
            [1, "age", 30],
          ],
        });

        const entity = await tx.getEntity(1);
        expect(entity).toHaveLength(2);
      });

      const entity = await db.getEntity(1);
      expect(entity).toHaveLength(2);

      await db.close();
    });

    test("should define attribute schema", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "email",
        cardinality: "one",
        unique: true,
        indexed: true,
      });

      const def = db.getAttributeDefinition("email");
      expect(def).toBeDefined();
      expect(def?.name).toBe("email");
      expect(def?.cardinality).toBe("one");
      expect(def?.unique).toBe(true);
      expect(def?.indexed).toBe(true);

      await db.close();
    });

    test("should query history with history flag", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.add([[1, "name", "Bob"]]);
      await db.retract([[1, "name", "Bob"]]);
      const tx4 = await db.add([[1, "name", "Charlie"]]);

      const history = await db.queryHistory({ entity: 1, attribute: "name" });
      expect(history.length).toBeGreaterThanOrEqual(3);

      // History should include all changes, ordered by transaction
      const txs = history.map((d) => d.tx);
      expect(txs).toEqual([...txs].sort((a, b) => a - b));

      // Should include retractions
      const retractions = history.filter((d) => !d.added);
      expect(retractions.length).toBeGreaterThan(0);

      await db.close();
    });

    test("should require at least one filter or limit for query", async () => {
      const { db } = f;
      expect(db.datoms({})).rejects.toThrow("full table scans");

      // History queries without filters should also require a limit
      expect(db.datoms({ history: true })).rejects.toThrow(
        "History query must include at least one filter or a limit"
      );

      // These should work
      await db.datoms({ entity: 1 });
      await db.datoms({ limit: 10 });
      await db.datoms({ history: true, limit: 100 });
      await db.datoms({ history: true, entity: 1 });

      await db.close();
    });

    test("should handle empty transact operations", async () => {
      const { db } = f;
      const tx = await db.transact({});
      expect(typeof tx).toBe("number");

      await db.close();
    });
  });
});
