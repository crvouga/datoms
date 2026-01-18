import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatalogQuery } from "../../datalog/datalog.js";
import { FIXTURES, type Fixture } from "./fixtures.js";

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
    test("should return a sample of N values from the set", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", 2, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]!["sample"];
      expect(sampleValues).toBeDefined();
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(2);
      // All values should be from the set
      (sampleValues as unknown as number[]).forEach((val) => {
        expect([10, 20, 30]).toContain(val);
      });
      // Should have no duplicates (sample is without replacement)
      const unique = new Set(sampleValues as unknown as number[]);
      expect(unique.size).toBe(2);

      await db.close();
    });

    test("should return null for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { sample: ["sample", 1, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(
        results[0]!["sample"] === null || results[0]!["sample"] === undefined
      ).toBe(true);

      await db.close();
    });

    test("should return single value when N=1", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", 1, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValue = results[0]!["sample"];
      expect(sampleValue).toBeDefined();
      expect([10, 20, 30]).toContain(sampleValue as number);
      expect(Array.isArray(sampleValue)).toBe(false);

      await db.close();
    });

    test("should return all values when N >= total", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", 5, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]!["sample"];
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(2);
      expect((sampleValues as unknown as number[]).sort()).toEqual([10, 20]);

      await db.close();
    });

    test("should return array of N values without duplicates", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
        { op: "assert", e: 4, a: "value", v: 40 },
        { op: "assert", e: 5, a: "value", v: 50 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", 3, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]!["sample"];
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(3);
      // Check no duplicates
      const unique = new Set(sampleValues as unknown as number[]);
      expect(unique.size).toBe(3);

      await db.close();
    });

    test("should work with string values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "name", v: "Charlie" },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", 2, "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]!["sample"];
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as string[]).length).toBe(2);
      (sampleValues as unknown as string[]).forEach((val) => {
        expect(["Alice", "Bob", "Charlie"]).toContain(val);
      });

      await db.close();
    });

    test("should work with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "product" },
        { op: "assert", e: 1, a: "price", v: 100 },
        { op: "assert", e: 2, a: "type", v: "product" },
        { op: "assert", e: 2, a: "price", v: 200 },
        { op: "assert", e: 3, a: "type", v: "service" },
        { op: "assert", e: 3, a: "price", v: 50 },
      ]);

      const query: DatalogQuery = {
        find: { sample: ["sample", 2, "?price"] },
        where: [
          { e: "?e", a: "type", v: "product" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]!["sample"];
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(2);
      expect((sampleValues as unknown as number[]).sort()).toEqual([100, 200]);

      await db.close();
    });
  });
});
