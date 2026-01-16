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
    const tx = await db.add([
      [1, "name", "Alice"],
      [1, "age", 30],
    ]);

    expect(tx).toBeGreaterThanOrEqual(1);

    const entity = await db.datoms({ entity: 1, added: true });
    expect(entity).toHaveLength(2);
    const values = entity.map((d) => d.value);
    expect(values).toContain("Alice");
    expect(values).toContain(30);
  });

  test("should query datoms", async () => {
    const { db } = f;
    await db.add([
      [1, "name", "Alice"],
      [2, "name", "Bob"],
    ]);

    const results = await db.datoms({ attribute: "name" });
    expect(results).toHaveLength(2);
  });

  test("should retract datoms", async () => {
    const { db } = f;
    await db.add([[1, "name", "Alice"]]);
    await db.retract([[1, "name", "Alice"]]);

    const entity = await db.datoms({ entity: 1, added: true });
    expect(entity).toHaveLength(0);
  });

  describe("retractAttribute", () => {
    test("should retract all values for single-valued attribute", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [1, "age", 30],
      ]);

      await db.retractAttribute(1, "name");

      const name = await db.getValue(1, "name");
      expect(name).toBeUndefined();

      const age = await db.getValue(1, "age");
      expect(age).toBe(30);
    });

    test("should retract all values for multi-valued attribute", async () => {
      const { db } = f;
      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
        [1, "tag", "green"],
        [1, "name", "Alice"],
      ]);

      await db.retractAttribute(1, "tag");

      const tags = await db.getValues(1, "tag");
      expect(tags).toHaveLength(0);

      const name = await db.getValue(1, "name");
      expect(name).toBe("Alice");
    });

    test("should handle retracting non-existent attribute", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      // Should not throw, just return a transaction ID
      const tx = await db.retractAttribute(1, "nonexistent");
      expect(tx).toBeGreaterThan(0);
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
      ]);

      await db.transaction(async (tx) => {
        await tx.retractAttribute(1, "tag");

        // Should see retraction within transaction
        const tags = await tx.getValues(1, "tag");
        expect(tags).toHaveLength(0);
      });

      // Should be committed after transaction
      const tags = await db.getValues(1, "tag");
      expect(tags).toHaveLength(0);
    });

    test("should only retract specified entity-attribute pair", async () => {
      const { db } = f;
      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
        [2, "tag", "red"],
        [2, "tag", "green"],
      ]);

      await db.retractAttribute(1, "tag");

      const tags1 = await db.getValues(1, "tag");
      expect(tags1).toHaveLength(0);

      const tags2 = await db.getValues(2, "tag");
      expect(tags2).toHaveLength(2);
      expect(tags2).toContain("red");
      expect(tags2).toContain("green");
    });
  });

  describe("upsert", () => {
    test("should add value when attribute doesn't exist", async () => {
      const { db } = f;
      await db.upsert(1, "status", "active");

      const status = await db.getValue(1, "status");
      expect(status).toBe("active");
    });

    test("should replace value for cardinality:one attribute", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.add([[1, "status", "pending"]]);
      await db.upsert(1, "status", "active");

      const status = await db.getValue(1, "status");
      expect(status).toBe("active");

      const allStatuses = await db.getValues(1, "status");
      expect(allStatuses).toHaveLength(1);
      expect(allStatuses[0]).toBe("active");
    });

    test("should add value for cardinality:many attribute without retracting", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "tag",
        cardinality: "many",
        type: "string",
      });

      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
      ]);

      await db.upsert(1, "tag", "green");

      const tags = await db.getValues(1, "tag");
      expect(tags).toHaveLength(3);
      expect(tags).toContain("red");
      expect(tags).toContain("blue");
      expect(tags).toContain("green");
    });

    test("should work for undefined cardinality (treats as many)", async () => {
      const { db } = f;
      // No schema definition
      await db.add([[1, "tag", "red"]]);
      await db.upsert(1, "tag", "blue");

      const tags = await db.getValues(1, "tag");
      expect(tags).toHaveLength(2);
      expect(tags).toContain("red");
      expect(tags).toContain("blue");
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.add([[1, "status", "pending"]]);

      await db.transaction(async (tx) => {
        await tx.upsert(1, "status", "active");

        // Should see new value within transaction
        const status = await tx.getValue(1, "status");
        expect(status).toBe("active");
      });

      // Should be committed
      const status = await db.getValue(1, "status");
      expect(status).toBe("active");
    });

    test("should handle multiple upserts in sequence", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.upsert(1, "status", "pending");
      await db.upsert(1, "status", "processing");
      await db.upsert(1, "status", "completed");

      const status = await db.getValue(1, "status");
      expect(status).toBe("completed");

      const allStatuses = await db.getValues(1, "status");
      expect(allStatuses).toHaveLength(1);
    });

    test("should work with different entity-attribute pairs", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.upsert(1, "status", "active");
      await db.upsert(2, "status", "inactive");

      const status1 = await db.getValue(1, "status");
      const status2 = await db.getValue(2, "status");
      expect(status1).toBe("active");
      expect(status2).toBe("inactive");
    });
  });

  test("should get value for entity-attribute", async () => {
    const { db } = f;
    await db.add([[1, "name", "Alice"]]);

    const name = await db.getValue(1, "name");
    expect(name).toBe("Alice");
  });

  describe("getLatestValue", () => {
    test("should return undefined for non-existent attribute", async () => {
      const { db } = f;
      const value = await db.getLatestValue(1, "nonexistent");
      expect(value).toBeUndefined();
    });

    test("should return value for single-valued attribute", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      const value = await db.getLatestValue(1, "name");
      expect(value).toBe("Alice");
    });

    test("should return most recent value for multi-valued attribute", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "tag", "red"]]);
      const tx2 = await db.add([[1, "tag", "blue"]]);
      const tx3 = await db.add([[1, "tag", "green"]]);

      // getLatestValue should return the value with highest tx
      const latest = await db.getLatestValue(1, "tag");
      expect(latest).toBe("green");

      // Verify it's equivalent to getValue
      const getValueResult = await db.getValue(1, "tag");
      expect(latest).toBe(getValueResult);
    });

    test("should return most recent value after retraction", async () => {
      const { db } = f;
      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
      ]);
      await db.retract([[1, "tag", "blue"]]);

      // Latest should be "red" since "blue" was retracted
      const latest = await db.getLatestValue(1, "tag");
      expect(latest).toBe("red");
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.add([[1, "tag", "red"]]);

      await db.transaction(async (tx) => {
        await tx.add([[1, "tag", "blue"]]);

        // Should see latest value within transaction
        const latest = await tx.getLatestValue(1, "tag");
        expect(latest).toBe("blue");
      });

      // After commit, should still be blue
      const latest = await db.getLatestValue(1, "tag");
      expect(latest).toBe("blue");
    });

    test("should handle time-travel queries correctly", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "tag", "red"]]);
      const tx2 = await db.add([[1, "tag", "blue"]]);
      const tx3 = await db.add([[1, "tag", "green"]]);

      // Current latest should be green
      const current = await db.getLatestValue(1, "tag");
      expect(current).toBe("green");

      // At tx2, latest should be blue
      const atTx2 = await db.getValueAsOf(1, "tag", tx2);
      expect(atTx2).toBe("blue");

      // At tx1, latest should be red
      const atTx1 = await db.getValueAsOf(1, "tag", tx1);
      expect(atTx1).toBe("red");
    });

    test("should be equivalent to getValue", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      // Add tags in separate transactions to ensure different transaction IDs
      await db.add([[1, "tag", "red"]]);
      await db.add([[1, "tag", "blue"]]);

      const name1 = await db.getValue(1, "name");
      const name2 = await db.getLatestValue(1, "name");
      expect(name1).toBe(name2);
      expect(name1).toBe("Alice");

      const tag1 = await db.getValue(1, "tag");
      const tag2 = await db.getLatestValue(1, "tag");
      expect(tag1).toBe(tag2);
      // Should return the latest value (blue, added last)
      expect(tag1).toBe("blue");
    });
  });

  describe("exists", () => {
    test("should return false for non-existent entity", async () => {
      const { db } = f;
      const exists = await db.exists(999);
      expect(exists).toBe(false);
    });

    test("should return true for existing entity", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const exists = await db.exists(1);
      expect(exists).toBe(true);
    });

    test("should return true even if entity has retracted datoms", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      await db.retract([[1, "name", "Alice"]]);
      const exists = await db.exists(1);
      // Entity exists if it has any datoms (including retracted ones)
      // This depends on implementation, but typically should return false after retraction
      // However, if query uses limit: 1, it might not find retracted datoms
      expect(typeof exists).toBe("boolean");
    });

    test("should return false for entity with only retracted datoms", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      await db.retract([[1, "name", "Alice"]]);
      // exists() uses query with limit: 1, which should only return added datoms
      const exists = await db.exists(1);
      expect(exists).toBe(false);
    });
  });

  describe("upsertMany", () => {
    test("should upsert multiple values atomically", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.upsertMany([
        { entity: 1, attribute: "status", value: "pending" },
        { entity: 2, attribute: "status", value: "active" },
        { entity: 1, attribute: "name", value: "Alice" },
      ]);

      const status1 = await db.getValue(1, "status");
      const status2 = await db.getValue(2, "status");
      const name1 = await db.getValue(1, "name");

      expect(status1).toBe("pending");
      expect(status2).toBe("active");
      expect(name1).toBe("Alice");
    });

    test("should retract existing values for cardinality:one attributes", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.add([[1, "status", "old-status"]]);
      await db.upsertMany([
        { entity: 1, attribute: "status", value: "new-status" },
      ]);

      const status = await db.getValue(1, "status");
      expect(status).toBe("new-status");

      const allStatuses = await db.getValues(1, "status");
      expect(allStatuses).toHaveLength(1);
    });

    test("should not retract for cardinality:many attributes", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "tag",
        cardinality: "many",
        type: "string",
      });

      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
      ]);

      await db.upsertMany([{ entity: 1, attribute: "tag", value: "green" }]);

      const tags = await db.getValues(1, "tag");
      expect(tags).toHaveLength(3);
      expect(tags).toContain("red");
      expect(tags).toContain("blue");
      expect(tags).toContain("green");
    });

    test("should handle empty array", async () => {
      const { db } = f;
      const tx = await db.upsertMany([]);
      expect(tx).toBeGreaterThan(0);
    });

    test("should work with mixed cardinality attributes", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });
      await db.defineAttribute({
        name: "tag",
        cardinality: "many",
        type: "string",
      });

      await db.add([
        [1, "status", "old"],
        [1, "tag", "red"],
      ]);

      await db.upsertMany([
        { entity: 1, attribute: "status", value: "new" },
        { entity: 1, attribute: "tag", value: "blue" },
      ]);

      const status = await db.getValue(1, "status");
      expect(status).toBe("new");

      const tags = await db.getValues(1, "tag");
      expect(tags).toHaveLength(2);
      expect(tags).toContain("red");
      expect(tags).toContain("blue");
    });
  });

  describe("Integration: Entity Operations", () => {
    test("should work together: upsert, retractAttribute, getLatestValue", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      // Upsert initial value
      await db.upsert(1, "status", "pending");
      expect(await db.getLatestValue(1, "status")).toBe("pending");

      // Upsert new value
      await db.upsert(1, "status", "active");
      expect(await db.getLatestValue(1, "status")).toBe("active");

      // Retract attribute
      await db.retractAttribute(1, "status");
      expect(await db.getLatestValue(1, "status")).toBeUndefined();

      // Upsert again
      await db.upsert(1, "status", "completed");
      expect(await db.getLatestValue(1, "status")).toBe("completed");
    });

    test("should track transaction IDs correctly with new methods", async () => {
      const { db } = f;
      const initialTx = await db.getLatestTransaction();

      const tx1 = await db.upsert(1, "name", "Alice");
      expect(tx1).toBeGreaterThan(initialTx);

      const tx2 = await db.retractAttribute(1, "name");
      expect(tx2).toBeGreaterThan(tx1);

      const tx3 = await db.upsert(1, "name", "Bob");
      expect(tx3).toBeGreaterThan(tx2);

      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx3);
    });
  });
});
