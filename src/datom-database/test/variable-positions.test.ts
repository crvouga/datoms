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

  describe("Database query (Datalog)", () => {
    test("should handle variable in entity position", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "age", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { e: ["?e"], v: ["?v"] },
        where: [{ e: "?e", a: "name", v: "?v" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const entities = results.map((r) => r["e"]).sort();
      expect(entities).toEqual([1, 2]);
      const values = results.map((r) => r["v"]).sort();
      expect(values).toEqual(["Alice", "Bob"]);
    });

    test("should handle variable in attribute position", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "city", v: "NYC" },
      ]);

      const query: DatalogQuery = {
        find: { attr: ["?attr"], v: ["?v"] },
        where: [{ e: 1, a: "?attr", v: "?v" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const attrs = results.map((r) => r["attr"]).sort();
      expect(attrs).toEqual(["age", "name"]);
      const values = results.map((r) => r["v"]).sort();
      expect(values).toEqual([30, "Alice"]);
    });

    test("should handle all positions as variables", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 25 },
      ]);

      const query: DatalogQuery = {
        find: { e: ["?e"], attr: ["?attr"], v: ["?v"] },
        where: [{ e: "?e", a: "?attr", v: "?v" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(4);
      // Verify we get all entity-attribute-value combinations
      const combinations = results.map((r) => ({
        e: r["e"],
        a: r["attr"],
        v: r["v"],
      }));
      expect(combinations).toContainEqual({ e: 1, a: "name", v: "Alice" });
      expect(combinations).toContainEqual({ e: 1, a: "age", v: 30 });
      expect(combinations).toContainEqual({ e: 2, a: "name", v: "Bob" });
      expect(combinations).toContainEqual({ e: 2, a: "age", v: 25 });
    });

    test("should handle string entity IDs", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: "user-1", a: "name", v: "Alice" },
        { op: "assert", e: "user-2", a: "name", v: "Bob" },
        { op: "assert", e: "user-1", a: "age", v: 30 },
      ]);
      const results = await db.queryWithMetadata({
        find: { e: ["?e"], n: ["?n"] },
        where: [
          { e: "?e", a: "name", v: "?n" },
          { e: "?e", a: "age", v: "?a" },
        ],
      });
      expect(results.data).toEqual([{ e: "user-1", n: "Alice" }]);
    });
  });
});
