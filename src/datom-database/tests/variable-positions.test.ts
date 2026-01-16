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
      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
        [3, "age", 30],
      ]);

      const query: DatalogQuery = {
        find: ["?e", "?v"],
        where: [["?e", "name", "?v"]],
      };

      const results = await db.queryDatalog(query);
      expect(results).toHaveLength(2);
      const entities = results.map((r) => r["e"]).sort();
      expect(entities).toEqual([1, 2]);
      const values = results.map((r) => r["v"]).sort();
      expect(values).toEqual(["Alice", "Bob"]);

      await db.close();
    });

    test("should handle variable in attribute position", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [1, "age", 30],
        [2, "name", "Bob"],
        [2, "city", "NYC"],
      ]);

      const query: DatalogQuery = {
        find: ["?attr", "?v"],
        where: [[1, "?attr", "?v"]],
      };

      const results = await db.queryDatalog(query);
      expect(results).toHaveLength(2);
      const attrs = results.map((r) => r["attr"]).sort();
      expect(attrs).toEqual(["age", "name"]);
      const values = results.map((r) => r["v"]).sort();
      expect(values).toEqual([30, "Alice"]);

      await db.close();
    });

    test("should handle all positions as variables", async () => {
      const { db } = f;
      await db.add([
        [1, "name", "Alice"],
        [1, "age", 30],
        [2, "name", "Bob"],
        [2, "age", 25],
      ]);

      const query: DatalogQuery = {
        find: ["?e", "?attr", "?v"],
        where: [["?e", "?attr", "?v"]],
      };

      const results = await db.queryDatalog(query);
      expect(results).toHaveLength(4);
      // Verify we get all entity-attribute-value combinations
      const combinations = results.map((r) => [r["e"], r["attr"], r["v"]]);
      expect(combinations).toContainEqual([1, "name", "Alice"]);
      expect(combinations).toContainEqual([1, "age", 30]);
      expect(combinations).toContainEqual([2, "name", "Bob"]);
      expect(combinations).toContainEqual([2, "age", 25]);

      await db.close();
    });

    test("should handle string entity IDs", async () => {
      const { db } = f;
      await db.add([
        ["user-1", "name", "Alice"],
        ["user-2", "name", "Bob"],
        ["user-1", "age", 30],
      ]);

      const query: DatalogQuery = {
        find: ["?e", "?n"],
        where: [
          ["?e", "name", "?n"],
          ["?e", "age", "?a"],
        ],
      };

      const results = await db.queryDatalog(query);
      expect(results).toHaveLength(1);
      expect(results[0]["e"]).toBe("user-1");
      expect(results[0]["n"]).toBe("Alice");

      await db.close();
    });
  });
});
