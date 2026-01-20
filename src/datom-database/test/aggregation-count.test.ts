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

  describe("Aggregation: count", () => {
    test("should count all matching values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "age", v: 25 },
        { op: "assert", e: 2, a: "age", v: 30 },
        { op: "assert", e: 3, a: "age", v: 35 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(3);
    });

    test("should return 0 for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { total: ["count", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(0);
    });

    test("should count single value", async () => {
      const { db } = f;
      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      const query: DatalogQuery = {
        find: { total: ["count", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(1);
    });

    test("should count with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "person" },
        { op: "assert", e: 2, a: "type", v: "person" },
        { op: "assert", e: 3, a: "type", v: "car" },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count", "?e"] },
        where: [{ e: "?e", a: "type", v: "person" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(2);
    });

    test("should count with multiple clauses", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 25 },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count", "?e"] },
        where: [
          { e: "?e", a: "name", v: "?name" },
          { e: "?e", a: "age", v: "?age" },
        ],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(2);
    });

    test("should count different data types", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 42 },
        { op: "assert", e: 2, a: "value", v: "test" },
        { op: "assert", e: 3, a: "value", v: true },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(3);
    });

    test("should count after retractions", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "item", v: "A" },
        { op: "assert", e: 2, a: "item", v: "B" },
        { op: "assert", e: 3, a: "item", v: "C" },
        { op: "assert", e: 4, a: "item", v: "D" },
      ]);

      // Retract two items
      await db.transact([
        { op: "retract", e: 2, a: "item", v: "B" },
        { op: "retract", e: 4, a: "item", v: "D" },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count", "?item"] },
        where: [{ e: "?e", a: "item", v: "?item" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(2);
    });

    test("should count with complex joins", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "order", v: 100 },
        { op: "assert", e: 1, a: "product", v: 1 },
        { op: "assert", e: 2, a: "order", v: 100 },
        { op: "assert", e: 2, a: "product", v: 2 },
        { op: "assert", e: 3, a: "order", v: 200 },
        { op: "assert", e: 3, a: "product", v: 1 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count", "?line"] },
        where: [
          { e: "?line", a: "order", v: "?order" },
          { e: "?line", a: "product", v: "?product" },
        ],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(3);
    });
  });
});
