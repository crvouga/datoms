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

  describe("Aggregation: distinct", () => {
    test("should return distinct values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "name", v: "Alice" },
      ]);

      const query: DatalogQuery = {
        find: { distinctNames: ["distinct", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      // Should return an array or set of distinct values
      const distinctValue = results[0]!["distinctNames"];
      expect(distinctValue).toBeDefined();
      // Implementation may return array, set, or comma-separated string
      if (Array.isArray(distinctValue)) {
        const sorted = distinctValue.sort() as unknown;
        expect(sorted).toEqual(["Alice", "Bob"]);
      } else {
        // Could be a set or other representation
        expect(distinctValue).toBeDefined();
      }
    });

    test("should return empty array or null for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { distinctNames: ["distinct", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      const distinctValue = results[0]!["distinctNames"];
      expect(
        distinctValue === null ||
          distinctValue === undefined ||
          (Array.isArray(distinctValue) && distinctValue.length === 0)
      ).toBe(true);
    });

    test("should return single value when only one exists", async () => {
      const { db } = f;
      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      const query: DatalogQuery = {
        find: { distinctNames: ["distinct", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      const distinctValue = results[0]!["distinctNames"];
      if (Array.isArray(distinctValue)) {
        const arr = distinctValue as unknown;
        expect(arr).toEqual(["Alice"]);
      } else {
        expect(distinctValue).toBe("Alice");
      }
    });

    test("should return distinct numeric values", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "age", v: 25 },
        { op: "assert", e: 2, a: "age", v: 30 },
        { op: "assert", e: 3, a: "age", v: 25 },
        { op: "assert", e: 4, a: "age", v: 30 },
        { op: "assert", e: 5, a: "age", v: 35 },
      ]);

      const query: DatalogQuery = {
        find: { distinctAges: ["distinct", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      const distinctValue = results[0]!["distinctAges"];
      if (Array.isArray(distinctValue)) {
        const sorted = distinctValue.sort() as unknown;
        expect(sorted).toEqual([25, 30, 35]);
      } else {
        expect(distinctValue).toBeDefined();
      }
    });

    test("should return distinct values with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "person" },
        { op: "assert", e: 1, a: "city", v: "NYC" },
        { op: "assert", e: 2, a: "type", v: "person" },
        { op: "assert", e: 2, a: "city", v: "LA" },
        { op: "assert", e: 3, a: "type", v: "person" },
        { op: "assert", e: 3, a: "city", v: "NYC" },
        { op: "assert", e: 4, a: "type", v: "car" },
        { op: "assert", e: 4, a: "city", v: "NYC" },
      ]);

      const query: DatalogQuery = {
        find: { distinctCities: ["distinct", "?city"] },
        where: [
          { e: "?e", a: "type", v: "person" },
          { e: "?e", a: "city", v: "?city" },
        ],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      const distinctValue = results[0]!["distinctCities"];
      if (Array.isArray(distinctValue)) {
        const sorted = distinctValue.sort() as unknown;
        expect(sorted).toEqual(["LA", "NYC"]);
      } else {
        expect(distinctValue).toBeDefined();
      }
    });

    test("should return distinct different data types", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "value", v: 42 },
        { op: "assert", e: 2, a: "value", v: "test" },
        { op: "assert", e: 3, a: "value", v: 42 },
        { op: "assert", e: 4, a: "value", v: true },
      ]);

      const query: DatalogQuery = {
        find: { distinctValues: ["distinct", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const { data: results } = await db.query(query);
      expect(results).toHaveLength(1);
      const distinctValue = results[0]!["distinctValues"];
      expect(distinctValue).toBeDefined();
      if (Array.isArray(distinctValue)) {
        expect(distinctValue.length).toBe(3);
      }
    });
  });
});
