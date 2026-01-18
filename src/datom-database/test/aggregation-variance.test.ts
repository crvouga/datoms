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

  describe("Aggregation: variance", () => {
    test("should calculate variance of numeric values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 20, variance = ((10-20)^2 + (20-20)^2 + (30-20)^2) / 3 = (100 + 0 + 100) / 3 = 66.67
      expect(results[0]!["variance"]).toBeCloseTo(66.67, 1);

      await db.close();
    });

    test("should return null or undefined for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(
        results[0]!["variance"] === null ||
          results[0]!["variance"] === undefined
      ).toBe(true);

      await db.close();
    });

    test("should return 0 or null for single value", async () => {
      const { db } = f;
      await db.transact([{ op: "assert", e: 1, a: "value", v: 10 }]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Variance of single value should be 0 or null/undefined
      expect(
        results[0]!["variance"] === 0 ||
          results[0]!["variance"] === null ||
          results[0]!["variance"] === undefined
      ).toBe(true);

      await db.close();
    });

    test("should calculate variance with identical values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 10 },
        { op: "assert", e: 3, a: "value", v: 10 },
      ]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Variance of identical values should be 0
      expect(results[0]!["variance"]).toBe(0);

      await db.close();
    });

    test("should calculate variance with negative numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: -10 },
        { op: "assert", e: 2, a: "value", v: 0 },
        { op: "assert", e: 3, a: "value", v: 10 },
      ]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 0, variance = ((-10-0)^2 + (0-0)^2 + (10-0)^2) / 3 = (100 + 0 + 100) / 3 = 66.67
      expect(results[0]!["variance"]).toBeCloseTo(66.67, 1);

      await db.close();
    });

    test("should calculate variance with decimal numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10.5 },
        { op: "assert", e: 2, a: "value", v: 20.5 },
        { op: "assert", e: 3, a: "value", v: 30.5 },
      ]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 20.5, variance = ((10.5-20.5)^2 + (20.5-20.5)^2 + (30.5-20.5)^2) / 3 = (100 + 0 + 100) / 3 = 66.67
      expect(results[0]!["variance"]).toBeCloseTo(66.67, 1);

      await db.close();
    });

    test("should calculate variance with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "group1" },
        { op: "assert", e: 1, a: "score", v: 80 },
        { op: "assert", e: 2, a: "type", v: "group1" },
        { op: "assert", e: 2, a: "score", v: 90 },
        { op: "assert", e: 3, a: "type", v: "group1" },
        { op: "assert", e: 3, a: "score", v: 100 },
        { op: "assert", e: 4, a: "type", v: "group2" },
        { op: "assert", e: 4, a: "score", v: 50 },
      ]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?score"] },
        where: [
          { e: "?e", a: "type", v: "group1" },
          { e: "?e", a: "score", v: "?score" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 90, variance = ((80-90)^2 + (90-90)^2 + (100-90)^2) / 3 = (100 + 0 + 100) / 3 = 66.67
      expect(results[0]!["variance"]).toBeCloseTo(66.67, 1);

      await db.close();
    });

    test("should calculate variance with larger dataset", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 1 },
        { op: "assert", e: 2, a: "value", v: 2 },
        { op: "assert", e: 3, a: "value", v: 3 },
        { op: "assert", e: 4, a: "value", v: 4 },
        { op: "assert", e: 5, a: "value", v: 5 },
      ]);

      const query: DatalogQuery = {
        find: { variance: ["variance", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 3, variance = ((1-3)^2 + (2-3)^2 + (3-3)^2 + (4-3)^2 + (5-3)^2) / 5 = (4 + 1 + 0 + 1 + 4) / 5 = 2
      expect(results[0]!["variance"]).toBeCloseTo(2, 1);

      await db.close();
    });
  });
});
