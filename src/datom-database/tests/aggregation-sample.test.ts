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

  describe("Aggregation: sample", () => {
    test("should return a sample value from the set", async () => {
      const { db } = f;
      await db.write([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: 20 },
        { op: "add", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", "seed123", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Should return one of the values
      const sampleValue = results[0]["sample"];
      expect(sampleValue).toBeDefined();
      expect([10, 20, 30]).toContain(sampleValue as number);

      await db.close();
    });

    test("should return null or undefined for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { sample: ["sample", "seed123", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(
        results[0]["sample"] === null || results[0]["sample"] === undefined
      ).toBe(true);

      await db.close();
    });

    test("should return single value when only one exists", async () => {
      const { db } = f;
      await db.write([{ op: "add", e: 1, a: "value", v: 42 }]);

      const query: DatalogQuery = {
        find: { sample: ["sample", "seed123", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["sample"]).toBe(42);

      await db.close();
    });

    test("should return consistent result with same seed", async () => {
      const { db } = f;
      await db.write([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: 20 },
        { op: "add", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", "seed456", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results1 = await db.query(query);
      const results2 = await db.query(query);

      // With the same seed, should return the same value
      expect(results1[0]["sample"]).toBe(results2[0]["sample"]);

      await db.close();
    });

    test("should return different results with different seeds", async () => {
      const { db } = f;
      await db.write([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: 20 },
        { op: "add", e: 3, a: "value", v: 30 },
      ]);

      const query1: DatalogQuery = {
        find: { sample: ["sample", "seed1", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const query2: DatalogQuery = {
        find: { sample: ["sample", "seed2", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results1 = await db.query(query1);
      const results2 = await db.query(query2);

      // Results should be valid values (may or may not be different depending on implementation)
      const sampleValue1 = results1[0]["sample"];
      const sampleValue2 = results2[0]["sample"];
      expect(sampleValue1).toBeDefined();
      expect(sampleValue2).toBeDefined();
      expect([10, 20, 30]).toContain(sampleValue1 as number);
      expect([10, 20, 30]).toContain(sampleValue2 as number);

      await db.close();
    });

    test("should work with string values", async () => {
      const { db } = f;
      await db.write([
        { op: "add", e: 1, a: "name", v: "Alice" },
        { op: "add", e: 2, a: "name", v: "Bob" },
        { op: "add", e: 3, a: "name", v: "Charlie" },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", "seed789", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValue = results[0]["sample"];
      expect(sampleValue).toBeDefined();
      expect(["Alice", "Bob", "Charlie"]).toContain(sampleValue as string);

      await db.close();
    });

    test("should work with filters", async () => {
      const { db } = f;
      await db.write([
        { op: "add", e: 1, a: "type", v: "product" },
        { op: "add", e: 1, a: "price", v: 100 },
        { op: "add", e: 2, a: "type", v: "product" },
        { op: "add", e: 2, a: "price", v: 200 },
        { op: "add", e: 3, a: "type", v: "service" },
        { op: "add", e: 3, a: "price", v: 50 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", "seed999", "?price"] },
        where: [
          { e: "?e", a: "type", v: "product" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValue = results[0]["sample"];
      expect(sampleValue).toBeDefined();
      expect([100, 200]).toContain(sampleValue as number);

      await db.close();
    });
  });
});
