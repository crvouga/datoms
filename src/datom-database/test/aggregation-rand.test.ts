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

  describe("Aggregation: rand", () => {
    test("should return N random values with replacement", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { random: ["rand", 3, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]!["random"];
      expect(randomValues).toBeDefined();
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as number[]).length).toBe(3);
      // All values should be from the set
      (randomValues as unknown as number[]).forEach((val) => {
        expect([10, 20, 30]).toContain(val);
      });
    });

    test("should return null for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { random: ["rand", 1, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(
        results[0]!["random"] === null || results[0]!["random"] === undefined
      ).toBe(true);
    });

    test("should return single value when N=1", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
        { op: "assert", e: 3, a: "value", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { random: ["rand", 1, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValue = results[0]!["random"];
      expect(randomValue).toBeDefined();
      expect([10, 20, 30]).toContain(randomValue as number);
      expect(Array.isArray(randomValue)).toBe(false);
    });

    test("should allow duplicates (with replacement)", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 10 },
        { op: "assert", e: 2, a: "value", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { random: ["rand", 5, "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]!["random"];
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as number[]).length).toBe(5);
      // Should allow duplicates (with replacement)
      (randomValues as unknown as number[]).forEach((val) => {
        expect([10, 20]).toContain(val);
      });
    });

    test("should work with string values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "name", v: "Charlie" },
      ]);

      const query: DatalogQuery = {
        find: { random: ["rand", 2, "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]!["random"];
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as string[]).length).toBe(2);
      (randomValues as unknown as string[]).forEach((val) => {
        expect(["Alice", "Bob", "Charlie"]).toContain(val);
      });
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
        find: { random: ["rand", 3, "?price"] },
        where: [
          { e: "?e", a: "type", v: "product" },
          { e: "?e", a: "price", v: "?price" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]!["random"];
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as number[]).length).toBe(3);
      (randomValues as unknown as number[]).forEach((val) => {
        expect([100, 200]).toContain(val);
      });
    });
  });
});
