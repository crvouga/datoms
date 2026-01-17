import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { QueryTimeoutError, TransactionConflictError } from "../errors.js";
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

  describe("With API (Speculative Transactions)", () => {
    test("should execute successful transaction", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      // Use with() to see what the transaction would look like
      const initial = await db.datoms({ e: 1 });
      expect(initial).toHaveLength(1);

      const withResult = await db.with({
        add: [{ e: 1, a: "status", v: "pending" }],
      });
      const updated = await withResult.dbAfter.datoms({ e: 1 });
      expect(updated).toHaveLength(2);

      // Now commit the changes
      await db.transact({ add: [{ e: 1, a: "status", v: "pending" }] });

      // Verify changes are committed
      const final = await db.datoms({ e: 1 });
      expect(final).toHaveLength(2);
      const values = final.map((d) => d.v);
      expect(values).toContain("Alice");
      expect(values).toContain("pending");

      await db.close();
    });

    test("should not commit changes when using with()", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      // Use with() to see what the transaction would look like
      const withResult = await db.with({
        add: [{ e: 1, a: "status", v: "pending" }],
      });

      // Query dbAfter to see speculative state
      const speculative = await withResult.dbAfter.datoms({ e: 1 });
      expect(speculative).toHaveLength(2);

      // But actual database should not be changed (with() doesn't commit)
      const final = await db.datoms({ e: 1 });
      expect(final).toHaveLength(1);
      expect(final[0].v).toBe("Alice");

      await db.close();
    });

    test("should see speculative changes with with()", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      // Query before adding
      const before = await db.datoms({ e: 1 });
      expect(before).toHaveLength(1);

      // Use with() to see what adding would look like
      const withResult = await db.with({ add: [{ e: 1, a: "age", v: 30 }] });

      // Query dbAfter - should see speculative change
      const after = await withResult.dbAfter.datoms({ e: 1 });
      expect(after).toHaveLength(2);
      const values = after.map((d) => d.v);
      expect(values).toContain("Alice");
      expect(values).toContain(30);

      await db.close();
    });

    test("should handle retract with with()", async () => {
      const { db } = f;

      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 1, a: "age", v: 30 },
        ],
      });

      // Use with() to see what retraction would look like
      const withResult = await db.with({
        retract: [{ e: 1, a: "age", v: 30 }],
      });

      // Query dbAfter should not see retracted datom
      const result = await withResult.dbAfter.datoms({ e: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].v).toBe("Alice");

      // Now commit the retraction
      await db.transact({ retract: [{ e: 1, a: "age", v: 30 }] });

      // Verify retraction is committed
      const final = await db.datoms({ e: 1 });
      expect(final).toHaveLength(1);
      expect(final[0].v).toBe("Alice");

      await db.close();
    });

    test("should handle query with with()", async () => {
      const { db } = f;

      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 2, a: "name", v: "Bob" },
        ],
      });

      // Use with() to see what adding would look like
      const withResult = await db.with({
        add: [{ e: 3, a: "name", v: "Charlie" }],
      });

      // Query dbAfter should see speculative change
      const results = await withResult.dbAfter.query({
        find: ["?x"],
        where: [["?x", "name", "?y"]],
      });

      expect(results).toHaveLength(3);
      const entities = results.map((r) => r["x"]).sort();
      expect(entities).toEqual([1, 2, 3]);

      await db.close();
    });

    test("should handle multiple operations with transact()", async () => {
      const { db } = f;

      // First add initial data
      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 1, a: "age", v: 30 },
        ],
      });

      // Then update in a single transaction: retract old age, add new age, add Bob
      await db.transact({
        add: [
          { e: 1, a: "age", v: 31 },
          { e: 2, a: "name", v: "Bob" },
        ],
        retract: [{ e: 1, a: "age", v: 30 }],
      });

      // Verify all operations were applied
      const alice = await db.datoms({ e: 1 });
      expect(alice).toHaveLength(2);
      const aliceValues = alice.map((d) => d.v);
      expect(aliceValues).toContain("Alice");
      expect(aliceValues).toContain(31);
      expect(aliceValues).not.toContain(30);

      const bob = await db.datoms({ e: 2 });
      expect(bob).toHaveLength(1);
      expect(bob[0].v).toBe("Bob");

      await db.close();
    });

    test("should not commit changes when using with()", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Initial" }] });

      // Use with() to see what the transaction would look like
      const withResult = await db.with({
        add: [
          { e: 1, a: "status", v: "pending" },
          { e: 2, a: "name", v: "New" },
        ],
        retract: [{ e: 1, a: "name", v: "Initial" }],
      });

      // Query dbAfter to see speculative state
      const speculative = await withResult.dbAfter.datoms({ e: 1 });
      expect(speculative.length).toBeGreaterThan(0);

      // But actual database should not be changed (with() doesn't commit)
      const result = await db.datoms({ e: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].v).toBe("Initial");

      const entity2 = await db.datoms({ e: 2 });
      expect(entity2).toHaveLength(0);

      await db.close();
    });

    test("should handle query with with()", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      const nameResults = await db.query({
        find: ["?v"],
        where: [[1, "name", "?v"]],
      });
      expect(nameResults[0]?.v).toBe("Alice");

      // Use with() to see what adding age would look like
      const withResult = await db.with({ add: [{ e: 1, a: "age", v: 30 }] });
      const ageResults = await withResult.dbAfter.query({
        find: ["?v"],
        where: [[1, "age", "?v"]],
      });
      expect(ageResults[0]?.v).toBe(30);

      await db.close();
    });

    test("should handle datoms query with with()", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      let entity = await db.datoms({ e: 1, added: true });
      expect(entity).toHaveLength(1);

      // Use with() to see what adding age would look like
      const withResult = await db.with({ add: [{ e: 1, a: "age", v: 30 }] });
      entity = await withResult.dbAfter.datoms({ e: 1, added: true });
      expect(entity).toHaveLength(2);

      await db.close();
    });

    test("should handle hasFact with with()", async () => {
      const { db } = f;

      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      const nameDatoms = await db.datoms({
        e: 1,
        a: "name",
        v: "Alice",
      });
      expect(nameDatoms.length).toBeGreaterThan(0);

      // Use with() to see what adding status would look like
      const withResult = await db.with({
        add: [{ e: 1, a: "status", v: "active" }],
      });
      const statusDatoms = await withResult.dbAfter.datoms({
        e: 1,
        a: "status",
        v: "active",
      });
      expect(statusDatoms.length).toBeGreaterThan(0);

      await db.close();
    });

    test("should handle complex query with with()", async () => {
      const { db } = f;

      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 1, a: "department", v: "Engineering" },
          { e: 2, a: "name", v: "Bob" },
          { e: 2, a: "department", v: "Sales" },
        ],
      });

      // Use with() to see what adding new employee would look like
      const withResult = await db.with({
        add: [
          { e: 3, a: "name", v: "Charlie" },
          { e: 3, a: "department", v: "Engineering" },
        ],
      });

      // Query dbAfter should see speculative change
      const results = await withResult.dbAfter.query({
        find: ["?name"],
        where: [
          ["?e", "name", "?name"],
          ["?e", "department", "Engineering"],
        ],
      });

      expect(results).toHaveLength(2);
      const names = results.map((r) => r["name"]).sort();
      expect(names).toEqual(["Alice", "Charlie"]);

      await db.close();
    });
  });

  describe("getLatestTransaction", () => {
    test("should return 0 for empty database", async () => {
      const { db } = f;
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(0);
    });

    test("should return latest transaction ID after adding datoms", async () => {
      const { db } = f;
      const tx1 = await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx1);

      const tx2 = await db.transact({ add: [{ e: 2, a: "name", v: "Bob" }] });
      const latestTx2 = await db.getLatestTransaction();
      expect(latestTx2).toBe(tx2);
      expect(latestTx2).toBeGreaterThan(tx1);
    });

    test("should return latest transaction after retraction", async () => {
      const { db } = f;
      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });
      const tx2 = await db.transact({
        retract: [{ e: 1, a: "name", v: "Alice" }],
      });
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx2);
    });

    test("should return latest transaction after transact", async () => {
      const { db } = f;
      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });
      const tx2 = await db.transact({
        add: [{ e: 2, a: "name", v: "Bob" }],
        retract: [{ e: 1, a: "name", v: "Alice" }],
      });
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx2);
    });

    test("should work with transact()", async () => {
      const { db } = f;
      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });
      const beforeTx = await db.getLatestTransaction();

      // Use transact() to commit changes
      const txId = await db.transact({ add: [{ e: 2, a: "name", v: "Bob" }] });
      expect(txId).toBeGreaterThan(beforeTx);

      // After commit, latest should be updated
      const afterTx = await db.getLatestTransaction();
      expect(afterTx).toBeGreaterThan(beforeTx);
      expect(afterTx).toBe(txId);
    });
  });

  describe("With Result", () => {
    test("should return dbBefore and dbAfter", async () => {
      const { db } = f;
      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      const withResult = await db.with({ add: [{ e: 1, a: "age", v: 30 }] });

      // dbBefore should show current state
      const before = await withResult.dbBefore.datoms({ e: 1 });
      expect(before).toHaveLength(1);
      expect(before[0].v).toBe("Alice");

      // dbAfter should show speculative state
      const after = await withResult.dbAfter.datoms({ e: 1 });
      expect(after).toHaveLength(2);
      const values = after.map((d) => d.v);
      expect(values).toContain("Alice");
      expect(values).toContain(30);
    });

    test("should return txData", async () => {
      const { db } = f;
      await db.transact({ add: [{ e: 1, a: "name", v: "Alice" }] });

      const withResult = await db.with({
        add: [{ e: 1, a: "age", v: 30 }],
        retract: [{ e: 1, a: "name", v: "Alice" }],
      });

      // txData should contain the datoms that would be applied
      expect(withResult.txData.length).toBeGreaterThan(0);
      const hasAdd = withResult.txData.some(
        (d) => d.e === 1 && d.a === "age" && d.v === 30 && d.added === true
      );
      expect(hasAdd).toBe(true);
      const hasRetract = withResult.txData.some(
        (d) =>
          d.e === 1 && d.a === "name" && d.v === "Alice" && d.added === false
      );
      expect(hasRetract).toBe(true);
    });

    test("should return tempIds (empty for now)", async () => {
      const { db } = f;
      const withResult = await db.with({
        add: [{ e: 1, a: "name", v: "Alice" }],
      });
      expect(withResult.tempIds).toEqual({});
    });
  });
});
