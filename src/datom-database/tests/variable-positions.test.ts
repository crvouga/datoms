import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DatalogQuery } from "../../datalog/datalog.js";
import { Fixture, FIXTURES } from "./fixtures.js";

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
        { op: "added", e: 1, a: "name", v: "Alice" },
        { op: "added", e: 2, a: "name", v: "Bob" },
        { op: "added", e: 3, a: "age", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: ["?e", "?v"],
        where: [["?e", "name", "?v"]],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const entities = results.map((r) => r["e"]).sort();
      expect(entities).toEqual([1, 2]);
      const values = results.map((r) => r["v"]).sort();
      expect(values).toEqual(["Alice", "Bob"]);

      await db.close();
    });

    test("should handle variable in attribute position", async () => {
      const { db } = f;
      await db.transact([
        { op: "added", e: 1, a: "name", v: "Alice" },
        { op: "added", e: 1, a: "age", v: 30 },
        { op: "added", e: 2, a: "name", v: "Bob" },
        { op: "added", e: 2, a: "city", v: "NYC" },
      ]);

      const query: DatalogQuery = {
        find: ["?attr", "?v"],
        where: [[1, "?attr", "?v"]],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const attrs = results.map((r) => r["attr"]).sort();
      expect(attrs).toEqual(["age", "name"]);
      const values = results.map((r) => r["v"]).sort();
      expect(values).toEqual([30, "Alice"]);

      await db.close();
    });

    test("should handle all positions as variables", async () => {
      const { db } = f;
      await db.transact([
        { op: "added", e: 1, a: "name", v: "Alice" },
        { op: "added", e: 1, a: "age", v: 30 },
        { op: "added", e: 2, a: "name", v: "Bob" },
        { op: "added", e: 2, a: "age", v: 25 },
      ]);

      const query: DatalogQuery = {
        find: ["?e", "?attr", "?v"],
        where: [["?e", "?attr", "?v"]],
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

      await db.close();
    });

    test("should handle string entity IDs", async () => {
      const { db } = f;
      await db.transact([
        { op: "added", e: "user-1", a: "name", v: "Alice" },
        { op: "added", e: "user-2", a: "name", v: "Bob" },
        { op: "added", e: "user-1", a: "age", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: ["?e", "?n"],
        where: [
          ["?e", "name", "?n"],
          ["?e", "age", "?a"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["e"]).toBe("user-1");
      expect(results[0]["n"]).toBe("Alice");

      await db.close();
    });
  });
});
