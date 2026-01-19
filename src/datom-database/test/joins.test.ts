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
    test("should handle multiple where clauses (join)", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 40 },
      ]);

      const query: DatalogQuery = {
        find: { x: ["?x"], a: ["?a"] },
        where: [
          { e: "?x", a: "name", v: "?n" },
          { e: "?x", a: "age", v: "?a" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const ages = results.map((r) => r["a"]);
      expect(ages).toContain(30);
      expect(ages).toContain(40);
    });

    test("should handle complex joins with multiple entities and attributes", async () => {
      const { db } = f;
      // Create a company structure: employees, departments, and their relationships
      await db.transact([
        // Employees
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "role", v: "engineer" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "role", v: "manager" },
        { op: "assert", e: 3, a: "name", v: "Charlie" },
        { op: "assert", e: 3, a: "role", v: "engineer" },
        // Departments
        { op: "assert", e: 10, a: "name", v: "Engineering" },
        { op: "assert", e: 10, a: "budget", v: "100_000" },
        { op: "assert", e: 11, a: "name", v: "Sales" },
        { op: "assert", e: 11, a: "budget", v: "50_000" },
        // Employee-Department relationships
        { op: "assert", e: 1, a: "department", v: 10 },
        { op: "assert", e: 2, a: "department", v: 10 },
        { op: "assert", e: 3, a: "department", v: 10 },
      ]);

      // Find all engineers in the Engineering department with the department budget
      const query: DatalogQuery = {
        find: { emp: ["?emp"], dept: ["?dept"], budget: ["?budget"] },
        where: [
          { e: "?emp", a: "role", v: "engineer" },
          { e: "?emp", a: "department", v: "?dept" },
          { e: "?dept", a: "name", v: "Engineering" },
          { e: "?dept", a: "budget", v: "?budget" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2); // Alice and Charlie are engineers
      const engineers = results.map((r) => r["emp"]).sort();
      expect(engineers).toEqual([1, 3]);
      // Both should be in Engineering with budget 100000
      results.forEach((r) => {
        expect(r["dept"]).toBe(10);
        expect(r["budget"]).toBe("100_000");
      });
    });

    test("should handle queries with multiple constraints on same entity", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 1, a: "city", v: "NYC" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 25 },
        { op: "assert", e: 2, a: "city", v: "NYC" },
        { op: "assert", e: 3, a: "name", v: "Charlie" },
        { op: "assert", e: 3, a: "age", v: 30 },
        { op: "assert", e: 3, a: "city", v: "LA" },
      ]);
      const results = await db.queryWithMetadata({
        find: { name: ["?name"] },
        where: [
          { e: "?e", a: "age", v: 30 },
          { e: "?e", a: "city", v: "NYC" },
          { e: "?e", a: "name", v: "?name" },
        ],
      });
      expect(results.data).toHaveLength(1);
      expect(results.data[0]!.name).toBe("Alice");
    });

    test("should handle complex variable bindings across multiple clauses", async () => {
      const { db } = f;
      // Create a network of connections
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Node1" },
        { op: "assert", e: 2, a: "name", v: "Node2" },
        { op: "assert", e: 3, a: "name", v: "Node3" },
        { op: "assert", e: 4, a: "name", v: "Node4" },
        // Connections: 1->2, 2->3, 3->4, 1->4
        { op: "assert", e: 1, a: "connects", v: 2 },
        { op: "assert", e: 2, a: "connects", v: 3 },
        { op: "assert", e: 3, a: "connects", v: 4 },
        { op: "assert", e: 1, a: "connects", v: 4 },
      ]);

      // Find all paths of length 2: A -> B -> C
      const query: DatalogQuery = {
        find: { a: ["?a"], b: ["?b"], c: ["?c"] },
        where: [
          { e: "?a", a: "connects", v: "?b" },
          { e: "?b", a: "connects", v: "?c" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2); // 1->2->3 and 2->3->4
      const paths = results.map((r) => [r["a"], r["b"], r["c"]]);
      expect(paths).toContainEqual([1, 2, 3]);
      expect(paths).toContainEqual([2, 3, 4]);
    });

    test("should handle join with no matching results", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "age", v: 30 },
      ]);

      const query: DatalogQuery = {
        find: { name: ["?name"], age: ["?age"] },
        where: [
          { e: "?e", a: "name", v: "?name" },
          { e: "?e", a: "age", v: "?age" },
        ],
      };

      const results = await db.query(query);
      // Entity 3 has age but no name, entities 1 and 2 have name but no age
      // So no results should match both conditions
      expect(results).toHaveLength(0);
    });

    test("should handle join with incompatible variable bindings", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 25 },
        // Entity 3 has name "Alice" but age 25 (different from entity 1)
        { op: "assert", e: 3, a: "name", v: "Alice" },
        { op: "assert", e: 3, a: "age", v: 25 },
      ]);

      // Find entities where name is Alice AND age is 25
      const query: DatalogQuery = {
        find: { e: ["?e"] },
        where: [
          { e: "?e", a: "name", v: "Alice" },
          { e: "?e", a: "age", v: 25 },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!.e).toBe(3);
    });

    test("should handle join with multiple common variables", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 1, a: "city", v: "NYC" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 30 },
        { op: "assert", e: 2, a: "city", v: "LA" },
      ]);

      const query: DatalogQuery = {
        find: { name: ["?name"], age: ["?age"], city: ["?city"] },
        where: [
          { e: "?e", a: "name", v: "?name" },
          { e: "?e", a: "age", v: "?age" },
          { e: "?e", a: "city", v: "?city" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const alice = results.find((r) => r["name"] === "Alice");
      expect(alice).toBeDefined();
      expect(alice?.["age"]).toBe(30);
      expect(alice?.["city"]).toBe("NYC");
    });

    test("should handle variable binding across disconnected clauses", async () => {
      const { db } = f;
      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 1, a: "age", v: 30 },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 2, a: "age", v: 25 },
        { op: "assert", e: 10, a: "employee", v: 1 },
        { op: "assert", e: 10, a: "department", v: "Engineering" },
        { op: "assert", e: 11, a: "employee", v: 2 },
        { op: "assert", e: 11, a: "department", v: "Sales" },
      ]);

      // Find employees and their departments through a join entity
      const query: DatalogQuery = {
        find: { name: ["?name"], dept: ["?dept"] },
        where: [
          { e: "?e", a: "name", v: "?name" },
          { e: "?j", a: "employee", v: "?e" },
          { e: "?j", a: "department", v: "?dept" },
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const alice = results.find((r) => r["name"] === "Alice");
      expect(alice).toBeDefined();
      expect(alice?.["dept"]).toBe("Engineering");
    });
  });
});
