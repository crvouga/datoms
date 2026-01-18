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

  describe("Multiple Aggregations", () => {
    test("should compute multiple aggregations in a single query", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "price", v: 100 },
        { op: "assert", e: 2, a: "price", v: 200 },
        { op: "assert", e: 3, a: "price", v: 300 },
      ]);

      const query: DatalogQuery = {
        find: {
          total: ["sum", "?price"],
          average: ["avg", "?price"],
          maximum: ["max", "?price"],
          minimum: ["min", "?price"],
          count: ["count", "?price"],
        },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(600);
      expect(results[0]!["average"]).toBe(200);
      expect(results[0]!["maximum"]).toBe(300);
      expect(results[0]!["minimum"]).toBe(100);
      expect(results[0]!["count"]).toBe(3);

      await db.close();
    });

    test("should compute statistical aggregations together", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
        { op: "assert", e: 4, a: "value", v: 40 },
        { op: "assert", e: 5, a: "value", v: 50 },
      ]);

      const query: DatalogQuery = {
        find: {
          average: ["avg", "?value"],
          median: ["median", "?value"],
          variance: ["variance", "?value"],
          stddev: ["stddev", "?value"],
        },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["average"]).toBe(30);
      expect(results[0]!["median"]).toBe(30);
      expect(results[0]!["variance"]).toBeCloseTo(200, 1);
      expect(results[0]!["stddev"]).toBeCloseTo(14.14, 1);

      await db.close();
    });

    test("should compute aggregations on different variables", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "price", v: 100 },
        { op: "assert", e: 1, a: "quantity", v: 5 },
        { op: "assert", e: 2, a: "price", v: 200 },
        { op: "assert", e: 2, a: "quantity", v: 3 },
        { op: "assert", e: 3, a: "price", v: 300 },
        { op: "assert", e: 3, a: "quantity", v: 2 },
      ]);

      const query: DatalogQuery = {
        find: {
          totalPrice: ["sum", "?price"],
          totalQuantity: ["sum", "?quantity"],
          avgPrice: ["avg", "?price"],
          maxQuantity: ["max", "?quantity"],
        },
        where: [
          { e: "?e", a: "price", v: "?price" },
          { e: "?e", a: "quantity", v: "?quantity" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["totalPrice"]).toBe(600);
      expect(results[0]!["totalQuantity"]).toBe(10);
      expect(results[0]!["avgPrice"]).toBe(200);
      expect(results[0]!["maxQuantity"]).toBe(5);

      await db.close();
    });

    test("should handle multiple aggregations with filters", async () => {
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
        find: {
          count: ["count", "?e"],
          total: ["sum", "?price"],
          average: ["avg", "?price"],
          maximum: ["max", "?price"],
        },
        where: [
          { e: "?e", a: "type", v: "product" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["count"]).toBe(2);
      expect(results[0]!["total"]).toBe(300);
      expect(results[0]!["average"]).toBe(150);
      expect(results[0]!["maximum"]).toBe(200);

      await db.close();
    });

    test("should compute distinct and count-distinct together", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "name", v: "Alice" },
        { op: "assert", e: 4, a: "name", v: "Charlie" },
      ]);

      const query: DatalogQuery = {
        find: {
          distinctNames: ["distinct", "?name"],
          distinctCount: ["count-distinct", "?name"],
          totalCount: ["count", "?name"],
        },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["distinctCount"]).toBe(3);
      expect(results[0]!["totalCount"]).toBe(4);
      const distinctNames = results[0]!["distinctNames"];
      if (Array.isArray(distinctNames)) {
        expect(distinctNames.length).toBe(3);
        expect([...distinctNames].sort()).toStrictEqual([
          "Alice",
          "Bob",
          "Charlie",
        ]);
      }

      await db.close();
    });

    test("should handle empty results with multiple aggregations", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: {
          total: ["sum", "?price"],
          average: ["avg", "?price"],
          maximum: ["max", "?price"],
          minimum: ["min", "?price"],
          count: ["count", "?price"],
        },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(0);
      expect(results[0]!["count"]).toBe(0);
      expect(
        results[0]!["average"] === null ||
        results[0]!["average"] === undefined ||
        results[0]!["average"] === 0
      ).toBe(true);
      expect(
        results[0]!["maximum"] === null || results[0]!["maximum"] === undefined
      ).toBe(true);
      expect(
        results[0]!["minimum"] === null || results[0]!["minimum"] === undefined
      ).toBe(true);

      await db.close();
    });

    test("should compute aggregations with sample and rand", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
        { op: "assert", e: 4, a: "value", v: 40 },
        { op: "assert", e: 5, a: "value", v: 50 },
      ]);

      const query: DatalogQuery = {
        find: {
          sample: ["sample", 3, "?value"],
          random: ["rand", 2, "?value"],
          count: ["count", "?value"],
        },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["count"]).toBe(5);
      const sample = results[0]!["sample"];
      const random = results[0]!["random"];
      expect(Array.isArray(sample)).toBe(true);
      expect(Array.isArray(random)).toBe(true);
      expect((sample as unknown as number[]).length).toBe(3);
      expect((random as unknown as number[]).length).toBe(2);

      await db.close();
    });
  });
});
