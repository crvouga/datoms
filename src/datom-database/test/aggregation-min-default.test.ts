import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatalogQuery } from "../../datalog/datalog.js";
import { FIXTURES } from "./fixtures/fixtures.js";
import type { Fixture } from "./fixtures/fixture.js";

describe.each(FIXTURES)("DatomDatabase (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Aggregation: min with default", () => {
    test("should find minimum value when values exist", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "age", v: 25 },
        { op: "assert", e: 2, a: "age", v: 30 },
        { op: "assert", e: 3, a: "age", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "0", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(20);
    });

    test("should return default value for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { minimum: ["min", "100", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Should return the default value when no results
      expect(results[0]!["minimum"]).toBe(100);
    });

    test("should find minimum of single value", async () => {
      const { db } = f;
      await db.transact([{ op: "assert", e: 1, a: "price", v: 100 }]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "0", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(100);
    });

    test("should find minimum with numeric default", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "5", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(10);
    });

    test("should use default when all values are filtered out", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "product" },
        { op: "assert", e: 1, a: "price", v: 100 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "50", "?price"] },
        where: [
          { e: "?e", a: "type", v: "service" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(50);
    });

    test("should find minimum with string default", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Charlie" },
        { op: "assert", e: 2, a: "name", v: "Alice" },
        { op: "assert", e: 3, a: "name", v: "Bob" },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "Z", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe("Alice");
    });

    test("should handle default with different data types", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "default", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      // Should return the minimum value (10) when values exist
      expect(results[0]!["minimum"]).toBe(10);
    });
  });
});
