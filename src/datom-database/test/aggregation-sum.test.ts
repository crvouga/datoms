import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatalogQuery } from "../../datalog/datalog.js";
import { FIXTURES, type Fixture } from "./fixtures.npm-ignore.js";

describe.each(FIXTURES)("DatomDatabase (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Aggregation: sum", () => {
    test("should sum numeric values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "age", v: 25 },
        { op: "assert", e: 2, a: "age", v: 30 },
        { op: "assert", e: 3, a: "age", v: 35 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(90);

      await db.close();
    });

    test("should return 0 for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { total: ["sum", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(0);

      await db.close();
    });

    test("should sum single value", async () => {
      const { db } = f;
      await db.transact([{ op: "assert", e: 1, a: "price", v: 100 }]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(100);

      await db.close();
    });

    test("should sum negative numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: -5 },
        { op: "assert", e: 3, a: "value", v: 3 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(8);

      await db.close();
    });

    test("should sum decimal numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "price", v: 10.5 },
        { op: "assert", e: 2, a: "price", v: 20.25 },
        { op: "assert", e: 3, a: "price", v: 5.75 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBeCloseTo(36.5, 2);

      await db.close();
    });

    test("should sum with filters", async () => {
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
        find: { total: ["sum", "?price"] },
        where: [
          { e: "?e", a: "type", v: "product" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(300);

      await db.close();
    });

    test("should sum large numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 1000000 },
        { op: "assert", e: 2, a: "value", v: 2000000 },
        { op: "assert", e: 3, a: "value", v: 3000000 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(6000000);

      await db.close();
    });

    test("should sum zero values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 0 },
        { op: "assert", e: 2, a: "value", v: 0 },
        { op: "assert", e: 3, a: "value", v: 10 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(10);

      await db.close();
    });

    test("should sum values after retraction", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "price", v: 100 },
        { op: "assert", e: 2, a: "price", v: 200 },
        { op: "assert", e: 3, a: "price", v: 300 },
      ]);

      // Retract one value
      await db.transact([{ op: "retract", e: 2, a: "price", v: 200 }]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBe(400);

      await db.close();
    });

    test("should sum with very small decimal numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 0.0001 },
        { op: "assert", e: 2, a: "value", v: 0.0002 },
        { op: "assert", e: 3, a: "value", v: 0.0003 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["sum", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!["total"]).toBeCloseTo(0.0006, 4);

      await db.close();
    });
  });
});
