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

  describe("Aggregation: min", () => {
    test("should find minimum numeric value", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "age", v: 25 },
        { op: "add", e: 2, a: "age", v: 30 },
        { op: "add", e: 3, a: "age", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?age"] },
        where: [{ e: "?e", a: "age", v: "?age" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["minimum"]).toBe(20);

      await db.close();
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
        results[0]["minimum"] === null || results[0]["minimum"] === undefined
      ).toBe(true);

      await db.close();
    });

    test("should find minimum of single value", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: 1, a: "price", v: 100 }]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["minimum"]).toBe(100);

      await db.close();
    });

    test("should find minimum with negative numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: -5 },
        { op: "add", e: 3, a: "value", v: 3 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["minimum"]).toBe(-5);

      await db.close();
    });

    test("should find minimum decimal numbers", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "price", v: 10.5 },
        { op: "add", e: 2, a: "price", v: 5.25 },
        { op: "add", e: 3, a: "price", v: 15.75 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?price"] },
        where: [{ e: "?e", a: "price", v: "?price" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["minimum"]).toBe(5.25);

      await db.close();
    });

    test("should find minimum string values", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "name", v: "Charlie" },
        { op: "add", e: 2, a: "name", v: "Alice" },
        { op: "add", e: 3, a: "name", v: "Bob" },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?name"] },
        where: [{ e: "?e", a: "name", v: "?name" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["minimum"]).toBe("Alice");

      await db.close();
    });

    test("should find minimum with filters", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "type", v: "product" },
        { op: "add", e: 1, a: "price", v: 100 },
        { op: "add", e: 2, a: "type", v: "product" },
        { op: "add", e: 2, a: "price", v: 50 },
        { op: "add", e: 3, a: "type", v: "service" },
        { op: "add", e: 3, a: "price", v: 25 },
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
      expect(results[0]["minimum"]).toBe(50);

      await db.close();
    });

    test("should find minimum with duplicate values", async () => {
      const { db } = f;
      await db.transact([
        { op: "add", e: 1, a: "value", v: 10 },
        { op: "add", e: 2, a: "value", v: 10 },
        { op: "add", e: 3, a: "value", v: 20 },
      ]);

      const query: DatalogQuery = {
        find: { minimum: ["min", "?value"] },
        where: [{ e: "?e", a: "value", v: "?value" }],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["minimum"]).toBe(10);

      await db.close();
    });
  });
});
