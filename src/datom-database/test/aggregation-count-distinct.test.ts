import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DatalogQuery } from "../../datalog/datalog.js";
import { Fixture, FIXTURES } from "../../test/fixtures.npm-ignore.js";

describe.each(FIXTURES)("DatomDatabase (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Aggregation: count-distinct", () => {
    test("should count distinct values", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "name", v: "Alice" },
        { op: "add", e: 2, a: "name", v: "Bob" },
        { op: "add", e: 3, a: "name", v: "Alice" },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count-distinct", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["total"]).toBe(2);

      await db.close();
    });

    test("should return 0 for empty results", async () => {
      const { db } = f;
      const query: DatalogQuery = {
        find: { total: ["count-distinct", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["total"]).toBe(0);

      await db.close();
    });

    test("should count distinct single value", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

      const query: DatalogQuery = {
        find: { total: ["count-distinct", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["total"]).toBe(1);

      await db.close();
    });

    test("should count distinct numeric values", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "age", v: 25 },
        { op: "add", e: 2, a: "age", v: 30 },
        { op: "add", e: 3, a: "age", v: 25 },
        { op: "add", e: 4, a: "age", v: 30 },
        { op: "add", e: 5, a: "age", v: 35 },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count-distinct", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["total"]).toBe(3);

      await db.close();
    });

    test("should count distinct with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "type", v: "person" },
        { op: "add", e: 1, a: "city", v: "NYC" },
        { op: "add", e: 2, a: "type", v: "person" },
        { op: "add", e: 2, a: "city", v: "LA" },
        { op: "add", e: 3, a: "type", v: "person" },
        { op: "add", e: 3, a: "city", v: "NYC" },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count-distinct", "?city"] },
        where: [
          { e: "?e", a: "type", v: "person" },
          { e: "?e", a: "city", v: "?city" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["total"]).toBe(2);

      await db.close();
    });

    test("should count distinct different data types", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "value", v: 42 },
        { op: "add", e: 2, a: "value", v: "test" },
        { op: "add", e: 3, a: "value", v: 42 },
        { op: "add", e: 4, a: "value", v: true },
      ]);

      const query: DatalogQuery = {
        find: { total: ["count-distinct", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["total"]).toBe(3);

      await db.close();
    });
  });
});
