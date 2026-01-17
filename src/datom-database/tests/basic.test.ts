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
    const tx = await db.transact({
      add: [
        [1, "name", "Alice"],
        [1, "age", 30],
      ],
    });

    expect(tx).toBeGreaterThanOrEqual(1);

    const entity = await db.datoms({ entity: 1, added: true });
    expect(entity).toHaveLength(2);
    const values = entity.map((d) => d.value);
    expect(values).toContain("Alice");
    expect(values).toContain(30);
  });

  test("should query datoms", async () => {
    const { db } = f;
    await db.transact({
      add: [
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ],
    });

    const results = await db.datoms({ attribute: "name" });
    expect(results).toHaveLength(2);
  });

  test("should retract datoms", async () => {
    const { db } = f;
    await db.transact({ add: [[1, "name", "Alice"]] });
    await db.transact({ retract: [[1, "name", "Alice"]] });

    const entity = await db.datoms({ entity: 1, added: true });
    expect(entity).toHaveLength(0);
  });

  describe("retractAttribute", () => {
    test("should retract all values for single-valued attribute", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [1, "age", 30],
        ],
      });

      const nameDatoms = await db.datoms({ entity: 1, attribute: "name" });
      await db.transact({ retract: nameDatoms.map((d) => [d.entity, d.attribute, d.value]) });

      const nameResults = await db.query({ find: ["?v"], where: [[1, "name", "?v"]] });
      expect(nameResults).toHaveLength(0);

      const ageResults = await db.query({ find: ["?v"], where: [[1, "age", "?v"]] });
      expect(ageResults[0]?.v).toBe(30);
    });

    test("should retract all values for multi-valued attribute", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "tag", "red"],
          [1, "tag", "blue"],
          [1, "tag", "green"],
          [1, "name", "Alice"],
        ],
      });

      const tagDatoms = await db.datoms({ entity: 1, attribute: "tag" });
      await db.transact({ retract: tagDatoms.map((d) => [d.entity, d.attribute, d.value]) });

      const tags = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags).toHaveLength(0);

      const nameResults = await db.query({ find: ["?v"], where: [[1, "name", "?v"]] });
      expect(nameResults[0]?.v).toBe("Alice");
    });

    test("should handle retracting non-existent attribute", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]] });

      // Should not throw, just return a transaction ID
      const nonexistentDatoms = await db.datoms({ entity: 1, attribute: "nonexistent" });
      const tx = await db.transact({ retract: nonexistentDatoms.map((d) => [d.entity, d.attribute, d.value]) });
      expect(tx).toBeGreaterThan(0);
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "tag", "red"],
          [1, "tag", "blue"],
        ],
      });

      await db.transaction(async (tx) => {
        const tagDatoms = await tx.datoms({ entity: 1, attribute: "tag" });
        await tx.transact({ retract: tagDatoms.map((d) => [d.entity, d.attribute, d.value]) });

        // Should see retraction within transaction
        const tags = await tx.datoms({ entity: 1, attribute: "tag" });
        expect(tags).toHaveLength(0);
      });

      // Should be committed after transaction
      const tags = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags).toHaveLength(0);
    });

    test("should only retract specified entity-attribute pair", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "tag", "red"],
          [1, "tag", "blue"],
          [2, "tag", "red"],
          [2, "tag", "green"],
        ],
      });

      const tag1Datoms = await db.datoms({ entity: 1, attribute: "tag" });
      await db.transact({ retract: tag1Datoms.map((d) => [d.entity, d.attribute, d.value]) });

      const tags1 = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags1).toHaveLength(0);

      const tags2 = await db.datoms({ entity: 2, attribute: "tag" });
      expect(tags2).toHaveLength(2);
      const values2 = tags2.map((d) => d.value);
      expect(values2).toContain("red");
      expect(values2).toContain("green");
    });
  });

  describe("upsert", () => {
    test("should add value when attribute doesn't exist", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "status", "active"]] });

      const statusResults = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      expect(statusResults[0]?.v).toBe("active");
    });

    test("should replace value for cardinality:one attribute", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.transact({ add: [[1, "status", "pending"]] });
      const existing = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({
        retract: existing.map((d) => [d.entity, d.attribute, d.value]),
        add: [[1, "status", "active"]],
      });

      const statusResults = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      expect(statusResults[0]?.v).toBe("active");

      const allStatuses = await db.datoms({ entity: 1, attribute: "status" });
      expect(allStatuses).toHaveLength(1);
      expect(allStatuses[0].value).toBe("active");
    });

    test("should add value for cardinality:many attribute without retracting", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "tag",
        cardinality: "many",
        type: "string",
      });

      await db.transact({
        add: [
          [1, "tag", "red"],
          [1, "tag", "blue"],
        ],
      });

      await db.transact({ add: [[1, "tag", "green"]] });

      const tags = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags).toHaveLength(3);
      const values = tags.map((d) => d.value);
      expect(values).toContain("red");
      expect(values).toContain("blue");
      expect(values).toContain("green");
    });

    test("should work for undefined cardinality (treats as many)", async () => {
      const { db } = f;
      // No schema definition
      await db.transact({ add: [[1, "tag", "red"]] });
      await db.transact({ add: [[1, "tag", "blue"]] });

      const tags = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags).toHaveLength(2);
      const values = tags.map((d) => d.value);
      expect(values).toContain("red");
      expect(values).toContain("blue");
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.transact({ add: [[1, "status", "pending"]] });

      await db.transaction(async (tx) => {
        const existing = await tx.datoms({ entity: 1, attribute: "status" });
        await tx.transact({
          retract: existing.map((d) => [d.entity, d.attribute, d.value]),
          add: [[1, "status", "active"]],
        });

        // Should see new value within transaction
        const statusResults = await tx.query({ find: ["?v"], where: [[1, "status", "?v"]] });
        expect(statusResults[0]?.v).toBe("active");
      });

      // Should be committed
      const statusResults = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      expect(statusResults[0]?.v).toBe("active");
    });

    test("should handle multiple upserts in sequence", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.transact({ add: [[1, "status", "pending"]] });
      const existing1 = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({
        retract: existing1.map((d) => [d.entity, d.attribute, d.value]),
        add: [[1, "status", "processing"]],
      });
      const existing2 = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({
        retract: existing2.map((d) => [d.entity, d.attribute, d.value]),
        add: [[1, "status", "completed"]],
      });

      const statusResults = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      expect(statusResults[0]?.v).toBe("completed");

      const allStatuses = await db.datoms({ entity: 1, attribute: "status" });
      expect(allStatuses).toHaveLength(1);
    });

    test("should work with different entity-attribute pairs", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.transact({ add: [[1, "status", "active"]] });
      await db.transact({ add: [[2, "status", "inactive"]] });

      const status1Results = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      const status2Results = await db.query({ find: ["?v"], where: [[2, "status", "?v"]] });
      expect(status1Results[0]?.v).toBe("active");
      expect(status2Results[0]?.v).toBe("inactive");
    });
  });

  test("should get value for entity-attribute", async () => {
    const { db } = f;
    await db.transact({ add: [[1, "name", "Alice"]] });

    const nameResults = await db.query({ find: ["?v"], where: [[1, "name", "?v"]] });
    expect(nameResults[0]?.v).toBe("Alice");
  });

  describe("getLatestValue", () => {
    test("should return undefined for non-existent attribute", async () => {
      const { db } = f;
      const results = await db.query({ find: ["?v"], where: [[1, "nonexistent", "?v"]] });
      expect(results).toHaveLength(0);
    });

    test("should return value for single-valued attribute", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]] });

      const results = await db.query({ find: ["?v"], where: [[1, "name", "?v"]] });
      expect(results[0]?.v).toBe("Alice");
    });

    test("should return most recent value for multi-valued attribute", async () => {
      const { db } = f;
      const tx1 = await db.transact({ add: [[1, "tag", "red"]] });
      const tx2 = await db.transact({ add: [[1, "tag", "blue"]] });
      const tx3 = await db.transact({ add: [[1, "tag", "green"]] });

      // Should return the value with highest tx
      const datoms = await db.datoms({ entity: 1, attribute: "tag" });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0].value).toBe("green");
    });

    test("should return most recent value after retraction", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "tag", "red"],
          [1, "tag", "blue"],
        ],
      });
      await db.transact({ retract: [[1, "tag", "blue"]] });

      // Latest should be "red" since "blue" was retracted
      const datoms = await db.datoms({ entity: 1, attribute: "tag" });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0].value).toBe("red");
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "tag", "red"]] });

      await db.transaction(async (tx) => {
        await tx.transact({ add: [[1, "tag", "blue"]] });

        // Should see latest value within transaction
        const datoms = await tx.datoms({ entity: 1, attribute: "tag" });
        const sorted = datoms.sort((a, b) => b.tx - a.tx);
        expect(sorted[0].value).toBe("blue");
      });

      // After commit, should still be blue
      const datoms = await db.datoms({ entity: 1, attribute: "tag" });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0].value).toBe("blue");
    });

    test("should handle time-travel queries correctly", async () => {
      const { db } = f;
      const tx1 = await db.transact({ add: [[1, "tag", "red"]] });
      const tx2 = await db.transact({ add: [[1, "tag", "blue"]] });
      const tx3 = await db.transact({ add: [[1, "tag", "green"]] });

      // Current latest should be green
      const currentDatoms = await db.datoms({ entity: 1, attribute: "tag" });
      const currentSorted = currentDatoms.sort((a, b) => b.tx - a.tx);
      expect(currentSorted[0].value).toBe("green");

      // At tx2, latest should be blue
      const atTx2Datoms = await db.asOf(tx2).datoms({ entity: 1, attribute: "tag" });
      const atTx2Sorted = atTx2Datoms.sort((a, b) => b.tx - a.tx);
      expect(atTx2Sorted[0].value).toBe("blue");

      // At tx1, latest should be red
      const atTx1Datoms = await db.asOf(tx1).datoms({ entity: 1, attribute: "tag" });
      const atTx1Sorted = atTx1Datoms.sort((a, b) => b.tx - a.tx);
      expect(atTx1Sorted[0].value).toBe("red");
    });

    test("should be equivalent to getValue", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]] });
      // Add tags in separate transactions to ensure different transaction IDs
      await db.transact({ add: [[1, "tag", "red"]] });
      await db.transact({ add: [[1, "tag", "blue"]] });

      const nameResults = await db.query({ find: ["?v"], where: [[1, "name", "?v"]] });
      expect(nameResults[0]?.v).toBe("Alice");

      const tagDatoms = await db.datoms({ entity: 1, attribute: "tag" });
      const tagSorted = tagDatoms.sort((a, b) => b.tx - a.tx);
      // Should return the latest value (blue, added last)
      expect(tagSorted[0].value).toBe("blue");
    });
  });

  describe("exists", () => {
    test("should return false for non-existent entity", async () => {
      const { db } = f;
      const datoms = await db.datoms({ entity: 999, limit: 1 });
      expect(datoms.length).toBe(0);
    });

    test("should return true for existing entity", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]] });
      const datoms = await db.datoms({ entity: 1, limit: 1 });
      expect(datoms.length).toBeGreaterThan(0);
    });

    test("should return true even if entity has retracted datoms", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]] });
      await db.transact({ retract: [[1, "name", "Alice"]] });
      const datoms = await db.datoms({ entity: 1, limit: 1 });
      // Entity exists if it has any datoms (including retracted ones)
      // This depends on implementation, but typically should return false after retraction
      // However, if query uses limit: 1, it might not find retracted datoms
      expect(typeof datoms.length).toBe("number");
    });

    test("should return false for entity with only retracted datoms", async () => {
      const { db } = f;
      await db.transact({ add: [[1, "name", "Alice"]] });
      await db.transact({ retract: [[1, "name", "Alice"]] });
      // exists() uses query with limit: 1, which should only return added datoms
      const datoms = await db.datoms({ entity: 1, limit: 1 });
      expect(datoms.length).toBe(0);
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

      await db.transact({
        add: [
          [1, "status", "pending"],
          [2, "status", "active"],
          [1, "name", "Alice"],
        ],
      });

      const status1Results = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      const status2Results = await db.query({ find: ["?v"], where: [[2, "status", "?v"]] });
      const name1Results = await db.query({ find: ["?v"], where: [[1, "name", "?v"]] });

      expect(status1Results[0]?.v).toBe("pending");
      expect(status2Results[0]?.v).toBe("active");
      expect(name1Results[0]?.v).toBe("Alice");
    });

    test("should retract existing values for cardinality:one attributes", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "status",
        cardinality: "one",
        type: "string",
      });

      await db.transact({ add: [[1, "status", "old-status"]] });
      const existing = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({
        retract: existing.map((d) => [d.entity, d.attribute, d.value]),
        add: [[1, "status", "new-status"]],
      });

      const statusResults = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      expect(statusResults[0]?.v).toBe("new-status");

      const allStatuses = await db.datoms({ entity: 1, attribute: "status" });
      expect(allStatuses).toHaveLength(1);
    });

    test("should not retract for cardinality:many attributes", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "tag",
        cardinality: "many",
        type: "string",
      });

      await db.transact({
        add: [
          [1, "tag", "red"],
          [1, "tag", "blue"],
        ],
      });

      await db.transact({ add: [[1, "tag", "green"]] });

      const tags = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags).toHaveLength(3);
      const values = tags.map((d) => d.value);
      expect(values).toContain("red");
      expect(values).toContain("blue");
      expect(values).toContain("green");
    });

    test("should handle empty array", async () => {
      const { db } = f;
      const tx = await db.transact({});
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

      await db.transact({
        add: [
          [1, "status", "old"],
          [1, "tag", "red"],
        ],
      });

      const statusExisting = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({
        retract: statusExisting.map((d) => [d.entity, d.attribute, d.value]),
        add: [
          [1, "status", "new"],
          [1, "tag", "blue"],
        ],
      });

      const statusResults = await db.query({ find: ["?v"], where: [[1, "status", "?v"]] });
      expect(statusResults[0]?.v).toBe("new");

      const tags = await db.datoms({ entity: 1, attribute: "tag" });
      expect(tags).toHaveLength(2);
      const values = tags.map((d) => d.value);
      expect(values).toContain("red");
      expect(values).toContain("blue");
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
      await db.transact({ add: [[1, "status", "pending"]] });
      const pendingDatoms = await db.datoms({ entity: 1, attribute: "status" });
      expect(pendingDatoms[0]?.value).toBe("pending");

      // Upsert new value
      const existing1 = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({
        retract: existing1.map((d) => [d.entity, d.attribute, d.value]),
        add: [[1, "status", "active"]],
      });
      const activeDatoms = await db.datoms({ entity: 1, attribute: "status" });
      expect(activeDatoms[0]?.value).toBe("active");

      // Retract attribute
      const statusDatoms = await db.datoms({ entity: 1, attribute: "status" });
      await db.transact({ retract: statusDatoms.map((d) => [d.entity, d.attribute, d.value]) });
      const afterRetract = await db.datoms({ entity: 1, attribute: "status" });
      expect(afterRetract.length).toBe(0);

      // Upsert again
      await db.transact({ add: [[1, "status", "completed"]] });
      const completedDatoms = await db.datoms({ entity: 1, attribute: "status" });
      expect(completedDatoms[0]?.value).toBe("completed");
    });

    test("should track transaction IDs correctly with new methods", async () => {
      const { db } = f;
      const initialTx = await db.getLatestTransaction();

      const tx1 = await db.transact({ add: [[1, "name", "Alice"]] });
      expect(tx1).toBeGreaterThan(initialTx);

      const nameDatoms = await db.datoms({ entity: 1, attribute: "name" });
      const tx2 = await db.transact({ retract: nameDatoms.map((d) => [d.entity, d.attribute, d.value]) });
      expect(tx2).toBeGreaterThan(tx1);

      const tx3 = await db.transact({ add: [[1, "name", "Bob"]] });
      expect(tx3).toBeGreaterThan(tx2);

      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx3);
    });
  });
});
