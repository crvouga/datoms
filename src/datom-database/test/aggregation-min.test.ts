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

  describe("Aggregation: min", () => {
    test("should find minimum numeric value", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "age", v: 25 },
        { op: "assert", e: 2, a: "age", v: 30 },
        { op: "assert", e: 3, a: "age", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(20);
    });

    test("should return null or undefined for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { minimum: ["min", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(
        results[0]!["minimum"] === null || results[0]!["minimum"] === undefined
      ).toBe(true);
    });

    test("should find minimum of single value", async () => {
      const { db } = f;
      await db.transact([{ op: "assert", e: 1, a: "price", v: 100 }]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(100);
    });

    test("should find minimum with negative numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: -5 },
        { op: "assert", e: 3, a: "value", v: 3 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(-5);
    });

    test("should find minimum decimal numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "price", v: 10.5 },
        { op: "assert", e: 2, a: "price", v: 5.25 },
        { op: "assert", e: 3, a: "price", v: 15.75 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(5.25);
    });

    test("should find minimum string values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Charlie" },
        { op: "assert", e: 2, a: "name", v: "Alice" },
        { op: "assert", e: 3, a: "name", v: "Bob" },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe("Alice");
    });

    test("should find minimum with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "product" },
        { op: "assert", e: 1, a: "price", v: 100 },
        { op: "assert", e: 2, a: "type", v: "product" },
        { op: "assert", e: 2, a: "price", v: 50 },
        { op: "assert", e: 3, a: "type", v: "service" },
        { op: "assert", e: 3, a: "price", v: 25 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?price"] },
        where: [
          { e: "?e", a: "type", v: "product" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(50);
    });

    test("should find minimum with duplicate values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 10 },
        { op: "assert", e: 3, a: "value", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(10);
    });

    test("should find minimum with zero values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 0 },
        { op: "assert", e: 2, a: "value", v: 10 },
        { op: "assert", e: 3, a: "value", v: 5 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(0);
    });

    test("should find minimum after updates", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "price", v: 100 },
        { op: "assert", e: 2, a: "price", v: 200 },
      ]);

      // Update to a lower value
      await db.transact([{ op: "assert", e: 2, a: "price", v: 50 }]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["minimum"]).toBe(50);
    });
  });
});
