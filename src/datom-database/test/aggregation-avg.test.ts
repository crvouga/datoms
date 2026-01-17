import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DatalogQuery } from "../../datalog/datalog.js";
import { Fixture, FIXTURES } from "../../test/fixtures.npm-ignore.js";

describe.each(FIXTURES)("DatomDatabase (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Aggregation: avg", () => {
    test("should calculate average of numeric values", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "age", v: 20 },
        { op: "add", e: 2, a: "age", v: 30 },
        { op: "add", e: 3, a: "age", v: 40 },
      ]);

      const query: DatalogQuery = {
        find: { average: ["avg", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["average"]).toBe(30);

      await db.close();
    });

    test("should return null or 0 for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { average: ["avg", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Average of empty set could be null, undefined, or 0 depending on implementation
      expect(
        results[0]["average"] === null ||
          results[0]["average"] === undefined ||
          results[0]["average"] === 0
      ).toBe(true);

      await db.close();
    });

    test("should calculate average of single value", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "score", v: 85 }]);

      const query: DatalogQuery = {
        find: { average: ["avg", "?score"] },
        where: [{ e: "?e", a: "score", v: "?score" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["average"]).toBe(85);

      await db.close();
    });

    test("should calculate average of decimal numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "price", v: 10.5 },
        { op: "add", e: 2, a: "price", v: 20.5 },
        { op: "add", e: 3, a: "price", v: 30.0 },
      ]);

      const query: DatalogQuery = {
        find: { average: ["avg", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["average"]).toBeCloseTo(20.333, 2);

      await db.close();
    });

    test("should calculate average with negative numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: -5 },
        { op: "add", e: 3, a: "value", v: 15 },
      ]);

      const query: DatalogQuery = {
        find: { average: ["avg", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["average"]).toBeCloseTo(6.667, 2);

      await db.close();
    });

    test("should calculate average with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "type", v: "student" },
        { op: "add", e: 1, a: "score", v: 80 },
        { op: "add", e: 2, a: "type", v: "student" },
        { op: "add", e: 2, a: "score", v: 90 },
        { op: "add", e: 3, a: "type", v: "teacher" },
        { op: "add", e: 3, a: "score", v: 95 },
      ]);

      const query: DatalogQuery = {
        find: { average: ["avg", "?score"] },
        where: [
          { e: "?e", a: "type", v: "student" },
          { e: "?e", a: "score", v: "?score" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["average"]).toBe(85);

      await db.close();
    });

    test("should calculate average with duplicate values", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: 10 },
        { op: "add", e: 3, a: "value", v: 10 },
      ]);

      const query: DatalogQuery = {
        find: { average: ["avg", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["average"]).toBe(10);

      await db.close();
    });
  });
});
