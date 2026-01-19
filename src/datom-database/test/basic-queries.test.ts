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

  describe("Database query (Datalog)", () => {
    test("should execute simple query", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
      ]);

      const query: DatalogQuery = {
        find: { x: ["?x"] },
        where: [{ e: "?x", a: "name", v: "?y" }],
      };

      expect(query.find.x).toEqual(["?x"]);
      expect(query.where).toHaveLength(1);

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      expect(results[0]!["x"]).toBe(1);
      expect(results[1]!["x"]).toBe(2);
    });

    test("should return empty if where is empty", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { x: ["?x"] },
        where: [],
      };

      const results = await db.query(query);
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    test("should filter by constant in where clause", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "type", v: "person" },
        { op: "assert", e: 2, a: "type", v: "car" },
        { op: "assert", e: 3, a: "type", v: "person" },
      ]);

      const query: DatalogQuery = {
        find: { x: ["?x"] },
        where: [{ e: "?x", a: "type", v: "person" }],
      };

      const results = await db.query(query);
      expect(results.map((r) => r["x"]).sort()).toEqual([1, 3]);
    });

    test("should handle empty find clause", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
      ]);

      const query: DatalogQuery = {
        find: {},
        where: [{ e: "?x", a: "name", v: "?y" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      // Empty find should return all variables from where clause
      expect(Object.keys(results[0]!).length).toBeGreaterThan(0);
    });

    test("should handle find variables not in where clause", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
      ]);

      const query: DatalogQuery = {
        find: { x: ["?x"], missing: ["?missing"] },
        where: [{ e: "?x", a: "name", v: "?y" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      // Missing variable should be undefined
      expect(results[0]!["x"]).toBeDefined();
      expect(results[0]!["missing"]).toBeUndefined();
      expect(results[1]?.["x"]).toBeDefined();
      expect(results[1]?.["missing"]).toBeUndefined();
    });
  });
});
