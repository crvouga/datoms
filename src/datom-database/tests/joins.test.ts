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
    test("should handle multiple where clauses (join)", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [1, "age", 30],
          [2, "name", "Bob"],
          [2, "age", 40],
        ],
      });

      const query: DatalogQuery = {
        find: ["?x", "?a"],
        where: [
          ["?x", "name", "?n"],
          ["?x", "age", "?a"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const ages = results.map((r) => r["a"]);
      expect(ages).toContain(30);
      expect(ages).toContain(40);

      await db.close();
    });

    test("should handle complex joins with multiple entities and attributes", async () => {
      const { db } = f;
      // Create a company structure: employees, departments, and their relationships
      await db.transact({
        add: [
          // Employees
          [1, "name", "Alice"],
          [1, "role", "engineer"],
          [2, "name", "Bob"],
          [2, "role", "manager"],
          [3, "name", "Charlie"],
          [3, "role", "engineer"],
          // Departments
          [10, "name", "Engineering"],
          [10, "budget", 100_000],
          [11, "name", "Sales"],
          [11, "budget", 50_000],
          // Employee-Department relationships
          [1, "department", 10],
          [2, "department", 10],
          [3, "department", 10],
        ],
      });

      // Find all engineers in the Engineering department with the department budget
      const query: DatalogQuery = {
        find: ["?emp", "?dept", "?budget"],
        where: [
          ["?emp", "role", "engineer"],
          ["?emp", "department", "?dept"],
          ["?dept", "name", "Engineering"],
          ["?dept", "budget", "?budget"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2); // Alice and Charlie are engineers
      const engineers = results.map((r) => r["emp"]).sort();
      expect(engineers).toEqual([1, 3]);
      // Both should be in Engineering with budget 100000
      results.forEach((r) => {
        expect(r["dept"]).toBe(10);
        expect(r["budget"]).toBe(100000);
      });

      await db.close();
    });

    test("should handle queries with multiple constraints on same entity", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [1, "age", 30],
          [1, "city", "NYC"],
          [2, "name", "Bob"],
          [2, "age", 25],
          [2, "city", "NYC"],
          [3, "name", "Charlie"],
          [3, "age", 30],
          [3, "city", "LA"],
        ],
      });

      // Find people in NYC who are 30 years old
      const query: DatalogQuery = {
        find: ["?name"],
        where: [
          ["?person", "name", "?name"],
          ["?person", "age", 30],
          ["?person", "city", "NYC"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["name"]).toBe("Alice");

      await db.close();
    });

    test("should handle complex variable bindings across multiple clauses", async () => {
      const { db } = f;
      // Create a network of connections
      await db.transact({
        add: [
          [1, "name", "Node1"],
          [2, "name", "Node2"],
          [3, "name", "Node3"],
          [4, "name", "Node4"],
          // Connections: 1->2, 2->3, 3->4, 1->4
          [1, "connects", 2],
          [2, "connects", 3],
          [3, "connects", 4],
          [1, "connects", 4],
        ],
      });

      // Find all paths of length 2: A -> B -> C
      const query: DatalogQuery = {
        find: ["?a", "?b", "?c"],
        where: [
          ["?a", "connects", "?b"],
          ["?b", "connects", "?c"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2); // 1->2->3 and 2->3->4
      const paths = results.map((r) => [r["a"], r["b"], r["c"]]);
      expect(paths).toContainEqual([1, 2, 3]);
      expect(paths).toContainEqual([2, 3, 4]);

      await db.close();
    });

    test("should handle join with no matching results", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [2, "name", "Bob"],
          [3, "age", 30],
        ],
      });

      const query: DatalogQuery = {
        find: ["?name", "?age"],
        where: [
          ["?e", "name", "?name"],
          ["?e", "age", "?age"],
        ],
      };

      const results = await db.query(query);
      // Entity 3 has age but no name, entities 1 and 2 have name but no age
      // So no results should match both conditions
      expect(results).toHaveLength(0);

      await db.close();
    });

    test("should handle join with incompatible variable bindings", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [1, "age", 30],
          [2, "name", "Bob"],
          [2, "age", 25],
          // Entity 3 has name "Alice" but age 25 (different from entity 1)
          [3, "name", "Alice"],
          [3, "age", 25],
        ],
      });

      // Find entities where name is Alice AND age is 25
      const query: DatalogQuery = {
        find: ["?e"],
        where: [
          ["?e", "name", "Alice"],
          ["?e", "age", 25],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]["e"]).toBe(3);

      await db.close();
    });

    test("should handle join with multiple common variables", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [1, "age", 30],
          [1, "city", "NYC"],
          [2, "name", "Bob"],
          [2, "age", 30],
          [2, "city", "LA"],
        ],
      });

      const query: DatalogQuery = {
        find: ["?name", "?age", "?city"],
        where: [
          ["?e", "name", "?name"],
          ["?e", "age", "?age"],
          ["?e", "city", "?city"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const alice = results.find((r) => r["name"] === "Alice");
      expect(alice).toBeDefined();
      expect(alice?.["age"]).toBe(30);
      expect(alice?.["city"]).toBe("NYC");

      await db.close();
    });

    test("should handle variable binding across disconnected clauses", async () => {
      const { db } = f;
      await db.transact({
        add: [
          [1, "name", "Alice"],
          [1, "age", 30],
          [2, "name", "Bob"],
          [2, "age", 25],
          [10, "employee", 1],
          [10, "department", "Engineering"],
          [11, "employee", 2],
          [11, "department", "Sales"],
        ],
      });

      // Find employees and their departments through a join entity
      const query: DatalogQuery = {
        find: ["?name", "?dept"],
        where: [
          ["?e", "name", "?name"],
          ["?j", "employee", "?e"],
          ["?j", "department", "?dept"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const alice = results.find((r) => r["name"] === "Alice");
      expect(alice).toBeDefined();
      expect(alice?.["dept"]).toBe("Engineering");

      await db.close();
    });
  });
});
