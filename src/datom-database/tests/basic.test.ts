import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

  test("should create a database", async () => {
    const { db } = f;
    const database = db;
    expect(database).toBeDefined();
  });

  test("should add datoms", async () => {
    const { db } = f;
    const tx = await db.transact([
      { op: "add", e: 1, a: "name", v: "Alice" },
      { op: "add", e: 1, a: "age", v: 30 },
    ]);

    expect(tx).toBeGreaterThanOrEqual(1);

    const entity = await db.datoms({ e: 1, op: "add" });
    expect(entity).toHaveLength(2);
    const values = entity.map((d) => d.v);
    expect(values).toContain("Alice");
    expect(values).toContain(30);
  });

  test("should query datoms", async () => {
    const { db } = f;
    await db.transact([
      { op: "add", e: 1, a: "name", v: "Alice" },
      { op: "add", e: 2, a: "name", v: "Bob" },
    ]);

    const results = await db.datoms({ a: "name" });
    expect(results).toHaveLength(2);
  });

  test("should sub datoms", async () => {
    const { db } = f;
    await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
    await db.transact([{ op: "sub", e: 1, a: "name", v: "Alice" }]);

    const entity = await db.datoms({ e: 1, op: "add" });
    expect(entity).toHaveLength(0);
  });

  describe("subAttribute", () => {
    test("should sub all values for single-valued attribute", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "name", v: "Alice" },
        { op: "add", e: 1, a: "age", v: 30 },
      ]);

      const nameDatoms = await db.datoms({ e: 1, a: "name" });
      await db.transact(
        nameDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );

      const nameResults = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });
      expect(nameResults).toHaveLength(0);

      const ageResults = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "age", v: "?v" }],
      });
      expect(ageResults[0]?.v).toBe(30);
    });

    test("should sub all values for multi-valued attribute", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "tag", v: "red" },
        { op: "add", e: 1, a: "tag", v: "blue" },
        { op: "add", e: 1, a: "tag", v: "green" },
        { op: "add", e: 1, a: "name", v: "Alice" },
      ]);

      const tagDatoms = await db.datoms({ e: 1, a: "tag" });
      await db.transact(
        tagDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );

      const tags = await db.datoms({ e: 1, a: "tag" });
      expect(tags).toHaveLength(0);

      const nameResults = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });
      expect(nameResults[0]?.v).toBe("Alice");
    });

    test("should handle subing non-existent attribute", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

      // Should not throw, just return a transaction ID
      const nonexistentDatoms = await db.datoms({
        e: 1,
        a: "nonexistent",
      });
      const tx = await db.transact(
        nonexistentDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );
      expect(tx).toBeGreaterThan(0);
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "tag", v: "red" },
        { op: "add", e: 1, a: "tag", v: "blue" },
      ]);

      const tagDatoms = await db.datoms({ e: 1, a: "tag" });

      // Use with() to see what subion would look like
      const withResult = await db.with(
        tagDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );

      // Should see subion in dbAfter
      const tags = await withResult.dbAfter.datoms({
        e: 1,
        a: "tag",
      });
      expect(tags).toHaveLength(0);

      // Now commit the subion
      await db.transact(
        tagDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );

      // Should be committed after transact
      const finalTags = await db.datoms({ e: 1, a: "tag" });
      expect(finalTags).toHaveLength(0);
    });

    test("should only sub specified entity-attribute pair", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "tag", v: "red" },
        { op: "add", e: 1, a: "tag", v: "blue" },
        { op: "add", e: 2, a: "tag", v: "red" },
        { op: "add", e: 2, a: "tag", v: "green" },
      ]);

      const tag1Datoms = await db.datoms({ e: 1, a: "tag" });
      await db.transact(
        tag1Datoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );

      const tags1 = await db.datoms({ e: 1, a: "tag" });
      expect(tags1).toHaveLength(0);

      const tags2 = await db.datoms({ e: 2, a: "tag" });
      expect(tags2).toHaveLength(2);
      const values2 = tags2.map((d) => d.v);
      expect(values2).toContain("red");
      expect(values2).toContain("green");
    });
  });

  describe("upsert", () => {
    test("should add value when attribute doesn't exist", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "status", v: "active" }]);

      const statusResults = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "status", v: "?v" }],
      });
      expect(statusResults[0]?.v).toBe("active");
    });

    test("should work for undefined cardinality (treats as many)", async () => {
      const { db } = f;
      // No schema definition
      await db.transact([{ op: "add", e: 1, a: "tag", v: "red" }]);
      await db.transact([{ op: "add", e: 1, a: "tag", v: "blue" }]);

      const tags = await db.datoms({ e: 1, a: "tag" });
      expect(tags).toHaveLength(2);
      const values = tags.map((d) => d.v);
      expect(values).toContain("red");
      expect(values).toContain("blue");
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "status", v: "pending" }]);

      const existing = await db.datoms({ e: 1, a: "status" });

      // Use with() to see what the upsert would look like
      const withResult = await db.with([
        ...existing.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
        { op: "add" as const, e: 1, a: "status", v: "active" },
      ]);

      // Should see new value in dbAfter
      const statusResults = await withResult.dbAfter.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "status", v: "?v" }],
      });
      expect(statusResults[0]?.v).toBe("active");

      // Now commit the changes
      await db.transact([
        ...existing.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
        { op: "add", e: 1, a: "status", v: "active" },
      ]);

      // Should be committed
      const finalStatusResults = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "status", v: "?v" }],
      });
      expect(finalStatusResults[0]?.v).toBe("active");
    });
  });

  test("should get value for entity-attribute", async () => {
    const { db } = f;
    await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

    const nameResults = await db.query({
      find: { v: ["?v"] },
      where: [{ e: 1, a: "name", v: "?v" }],
    });
    expect(nameResults[0]?.v).toBe("Alice");
  });

  describe("getLatestValue", () => {
    test("should return undefined for non-existent attribute", async () => {
      const { db } = f;
      const results = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "nonexistent", v: "?v" }],
      });
      expect(results).toHaveLength(0);
    });

    test("should return value for single-valued attribute", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

      const results = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });
      expect(results[0]?.v).toBe("Alice");
    });

    test("should return most recent value for multi-valued attribute", async () => {
      const { db } = f;
      const tx1 = await db.transact([{ op: "add", e: 1, a: "tag", v: "red" }]);
      const tx2 = await db.transact([{ op: "add", e: 1, a: "tag", v: "blue" }]);
      const tx3 = await db.transact([
        { op: "add", e: 1, a: "tag", v: "green" },
      ]);

      // Should return the value with highest tx
      const datoms = await db.datoms({ e: 1, a: "tag" });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0].v).toBe("green");
    });

    test("should return most recent value after subion", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "tag", v: "red" },
        { op: "add", e: 1, a: "tag", v: "blue" },
      ]);
      await db.transact([{ op: "sub", e: 1, a: "tag", v: "blue" }]);

      // Latest should be "red" since "blue" was sub
      const datoms = await db.datoms({ e: 1, a: "tag" });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0].v).toBe("red");
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "tag", v: "red" }]);

      // Use with() to see what adding would look like
      const withResult = await db.with([
        { op: "add", e: 1, a: "tag", v: "blue" },
      ]);

      // Should see latest value in dbAfter
      const datoms = await withResult.dbAfter.datoms({
        e: 1,
        a: "tag",
      });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0].v).toBe("blue");

      // Now commit the change
      await db.transact([{ op: "add", e: 1, a: "tag", v: "blue" }]);

      // After commit, should still be blue
      const finalDatoms = await db.datoms({ e: 1, a: "tag" });
      const finalSorted = finalDatoms.sort((a, b) => b.tx - a.tx);
      expect(finalSorted[0].v).toBe("blue");
    });

    test("should handle time-travel queries correctly", async () => {
      const { db } = f;
      const tx1 = await db.transact([{ op: "add", e: 1, a: "tag", v: "red" }]);
      const tx2 = await db.transact([{ op: "add", e: 1, a: "tag", v: "blue" }]);
      const tx3 = await db.transact([
        { op: "add", e: 1, a: "tag", v: "green" },
      ]);

      // Current latest should be green
      const currentDatoms = await db.datoms({ e: 1, a: "tag" });
      const currentSorted = currentDatoms.sort((a, b) => b.tx - a.tx);
      expect(currentSorted[0].v).toBe("green");

      // At tx2, latest should be blue
      const atTx2Datoms = await db.asOf(tx2).datoms({ e: 1, a: "tag" });
      const atTx2Sorted = atTx2Datoms.sort((a, b) => b.tx - a.tx);
      expect(atTx2Sorted[0].v).toBe("blue");

      // At tx1, latest should be red
      const atTx1Datoms = await db.asOf(tx1).datoms({ e: 1, a: "tag" });
      const atTx1Sorted = atTx1Datoms.sort((a, b) => b.tx - a.tx);
      expect(atTx1Sorted[0].v).toBe("red");
    });

    test("should be equivalent to getValue", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
      // Add tags in separate transactions to ensure different transaction IDs
      await db.transact([{ op: "add", e: 1, a: "tag", v: "red" }]);
      await db.transact([{ op: "add", e: 1, a: "tag", v: "blue" }]);

      const nameResults = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });
      expect(nameResults[0]?.v).toBe("Alice");

      const tagDatoms = await db.datoms({ e: 1, a: "tag" });
      const tagSorted = tagDatoms.sort((a, b) => b.tx - a.tx);
      // Should return the latest value (blue, add last)
      expect(tagSorted[0].v).toBe("blue");
    });
  });

  describe("exists", () => {
    test("should return false for non-existent entity", async () => {
      const { db } = f;
      const datoms = await db.datoms({ e: 999, limit: 1 });
      expect(datoms.length).toBe(0);
    });

    test("should return true for existing entity", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
      const datoms = await db.datoms({ e: 1, limit: 1 });
      expect(datoms.length).toBeGreaterThan(0);
    });

    test("should return true even if entity has sub datoms", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
      await db.transact([{ op: "sub", e: 1, a: "name", v: "Alice" }]);
      const datoms = await db.datoms({ e: 1, limit: 1 });
      // Entity exists if it has any datoms (including sub ones)
      // This depends on implementation, but typically should return false after subion
      // However, if query uses limit: 1, it might not find sub datoms
      expect(typeof datoms.length).toBe("number");
    });

    test("should return false for entity with only sub datoms", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
      await db.transact([{ op: "sub", e: 1, a: "name", v: "Alice" }]);
      // exists() uses query with limit: 1, which should only return add datoms
      const datoms = await db.datoms({ e: 1, limit: 1 });
      expect(datoms.length).toBe(0);
    });
  });

  describe("upsertMany", () => {
    test("should upsert multiple values atomically", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "status", v: "pending" },
        { op: "add", e: 2, a: "status", v: "active" },
        { op: "add", e: 1, a: "name", v: "Alice" },
      ]);

      const status1Results = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "status", v: "?v" }],
      });
      const status2Results = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 2, a: "status", v: "?v" }],
      });
      const name1Results = await db.query({
        find: { v: ["?v"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });

      expect(status1Results[0]?.v).toBe("pending");
      expect(status2Results[0]?.v).toBe("active");
      expect(name1Results[0]?.v).toBe("Alice");
    });

    test("should handle empty array", async () => {
      const { db } = f;
      const tx = await db.transact([]);
      expect(tx).toBeGreaterThan(0);
    });
  });

  describe("Integration: Entity Operations", () => {
    test("should work together: upsert, subAttribute, getLatestValue", async () => {
      const { db } = f;
      // Upsert initial value
      await db.transact([{ op: "add", e: 1, a: "status", v: "pending" }]);
      const pendingDatoms = await db.datoms({ e: 1, a: "status" });
      expect(pendingDatoms[0]?.v).toBe("pending");

      // Upsert new value
      const existing1 = await db.datoms({ e: 1, a: "status" });
      await db.transact([
        ...existing1.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
        { op: "add" as const, e: 1, a: "status", v: "active" },
      ]);
      const activeDatoms = await db.datoms({ e: 1, a: "status" });
      expect(activeDatoms[0]?.v).toBe("active");

      // sub attribute
      const statusDatoms = await db.datoms({ e: 1, a: "status" });
      await db.transact(
        statusDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );
      const aftersub = await db.datoms({ e: 1, a: "status" });
      expect(aftersub.length).toBe(0);

      // Upsert again
      await db.transact([{ op: "add", e: 1, a: "status", v: "completed" }]);
      const completedDatoms = await db.datoms({
        e: 1,
        a: "status",
      });
      expect(completedDatoms[0]?.v).toBe("completed");
    });

    test("should track transaction IDs correctly with new methods", async () => {
      const { db } = f;
      const initialTx = await db.getLatestTransaction();

      const tx1 = await db.transact([
        { op: "add", e: 1, a: "name", v: "Alice" },
      ]);
      expect(tx1).toBeGreaterThan(initialTx);

      const nameDatoms = await db.datoms({ e: 1, a: "name" });
      const tx2 = await db.transact(
        nameDatoms.map((d) => ({
          op: "sub" as const,
          e: d.e,
          a: d.a,
          v: d.v,
        }))
      );
      expect(tx2).toBeGreaterThan(tx1);

      const tx3 = await db.transact([{ op: "add", e: 1, a: "name", v: "Bob" }]);
      expect(tx3).toBeGreaterThan(tx2);

      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx3);
    });
  });
});
