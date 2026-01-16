import { test, expect, describe } from "bun:test";
import { Database, MemoryBackend, DatalogQueryEngine } from "../index";
import type { DatalogQuery } from "../index";

describe("DatalogQueryEngine", () => {
  test("should execute simple query", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
    ]);

    const engine = new DatalogQueryEngine(db);
    const query: DatalogQuery = {
      find: ["?x"],
      where: [{ entity: "?x", attribute: "name", value: "?y" }],
    };

    expect(query.find).toContain("?x");
    expect(query.where).toHaveLength(1);

    const results = await engine.query(query);
    expect(results).toHaveLength(2);
    expect(results[0]["?x"]).toBe(1);
    expect(results[1]["?x"]).toBe(2);

    await db.close();
  });

  test("should handle multiple where clauses (join)", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 1, attribute: "age", value: 30 },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 2, attribute: "age", value: 40 },
    ]);

    const engine = new DatalogQueryEngine(db);
    const query: DatalogQuery = {
      find: ["?x", "?a"],
      where: [
        { entity: "?x", attribute: "name", value: "?n" },
        { entity: "?x", attribute: "age", value: "?a" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(2);
    const ages = results.map((r) => r["?a"]);
    expect(ages).toContain(30);
    expect(ages).toContain(40);

    await db.close();
  });

  test("should support ordering and limits", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "score", value: 100 },
      { entity: 2, attribute: "score", value: 400 },
      { entity: 3, attribute: "score", value: 250 },
    ]);

    const engine = new DatalogQueryEngine(db);
    const query: DatalogQuery = {
      find: ["?e", "?s"],
      where: [{ entity: "?e", attribute: "score", value: "?s" }],
      orderBy: [{ variable: "?s", direction: "desc" }],
      limit: 2,
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(2);
    expect(results[0]["?s"]).toBe(400);
    expect(results[1]["?s"]).toBe(250);

    await db.close();
  });

  test("should return empty if where is empty", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    const engine = new DatalogQueryEngine(db);
    const query: DatalogQuery = {
      find: ["?x"],
      where: [],
    };

    const results = await engine.query(query);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);

    await db.close();
  });

  test("should filter by constant in where clause", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "type", value: "person" },
      { entity: 2, attribute: "type", value: "car" },
      { entity: 3, attribute: "type", value: "person" },
    ]);

    const engine = new DatalogQueryEngine(db);
    const query: DatalogQuery = {
      find: ["?x"],
      where: [{ entity: "?x", attribute: "type", value: "person" }],
    };

    const results = await engine.query(query);
    expect(results.map((r) => r["?x"]).sort()).toEqual([1, 3]);

    await db.close();
  });

  test("should handle multi-entity relationships (friendships)", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    // Create people
    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 3, attribute: "name", value: "Charlie" },
      // Friendships: Alice -> Bob, Bob -> Charlie
      { entity: 10, attribute: "from", value: 1 },
      { entity: 10, attribute: "to", value: 2 },
      { entity: 10, attribute: "type", value: "friendship" },
      { entity: 11, attribute: "from", value: 2 },
      { entity: 11, attribute: "to", value: 3 },
      { entity: 11, attribute: "type", value: "friendship" },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find all friendships: who is friends with whom
    const query: DatalogQuery = {
      find: ["?from", "?to"],
      where: [
        { entity: "?f", attribute: "from", value: "?from" },
        { entity: "?f", attribute: "to", value: "?to" },
        { entity: "?f", attribute: "type", value: "friendship" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(2);
    const friendships = results.map((r) => [r["?from"], r["?to"]]);
    expect(friendships).toContainEqual([1, 2]);
    expect(friendships).toContainEqual([2, 3]);

    await db.close();
  });

  test("should handle transitive relationships (friends of friends)", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    // Create people and friendships
    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 3, attribute: "name", value: "Charlie" },
      { entity: 4, attribute: "name", value: "Diana" },
      // Friendships: Alice -> Bob, Bob -> Charlie, Bob -> Diana
      { entity: 10, attribute: "from", value: 1 },
      { entity: 10, attribute: "to", value: 2 },
      { entity: 11, attribute: "from", value: 2 },
      { entity: 11, attribute: "to", value: 3 },
      { entity: 12, attribute: "from", value: 2 },
      { entity: 12, attribute: "to", value: 4 },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find friends of Alice's friends (friends of friends)
    const query: DatalogQuery = {
      find: ["?friendOfFriend"],
      where: [
        { entity: "?f1", attribute: "from", value: 1 },
        { entity: "?f1", attribute: "to", value: "?friend" },
        { entity: "?f2", attribute: "from", value: "?friend" },
        { entity: "?f2", attribute: "to", value: "?friendOfFriend" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(2);
    const friendOfFriends = results.map((r) => r["?friendOfFriend"]).sort();
    expect(friendOfFriends).toEqual([3, 4]);

    await db.close();
  });

  test("should handle complex joins with multiple entities and attributes", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    // Create a company structure: employees, departments, and their relationships
    await db.add([
      // Employees
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 1, attribute: "role", value: "engineer" },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 2, attribute: "role", value: "manager" },
      { entity: 3, attribute: "name", value: "Charlie" },
      { entity: 3, attribute: "role", value: "engineer" },
      // Departments
      { entity: 10, attribute: "name", value: "Engineering" },
      { entity: 10, attribute: "budget", value: 100000 },
      { entity: 11, attribute: "name", value: "Sales" },
      { entity: 11, attribute: "budget", value: 50000 },
      // Employee-Department relationships
      { entity: 1, attribute: "department", value: 10 },
      { entity: 2, attribute: "department", value: 10 },
      { entity: 3, attribute: "department", value: 10 },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find all engineers in the Engineering department with the department budget
    const query: DatalogQuery = {
      find: ["?emp", "?dept", "?budget"],
      where: [
        { entity: "?emp", attribute: "role", value: "engineer" },
        { entity: "?emp", attribute: "department", value: "?dept" },
        { entity: "?dept", attribute: "name", value: "Engineering" },
        { entity: "?dept", attribute: "budget", value: "?budget" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(2); // Alice and Charlie are engineers
    const engineers = results.map((r) => r["?emp"]).sort();
    expect(engineers).toEqual([1, 3]);
    // Both should be in Engineering with budget 100000
    results.forEach((r) => {
      expect(r["?dept"]).toBe(10);
      expect(r["?budget"]).toBe(100000);
    });

    await db.close();
  });

  test("should handle parent-child relationships", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    // Create a family tree
    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 3, attribute: "name", value: "Charlie" },
      { entity: 4, attribute: "name", value: "Diana" },
      // Alice is parent of Bob and Charlie
      { entity: 1, attribute: "child", value: 2 },
      { entity: 1, attribute: "child", value: 3 },
      // Bob is parent of Diana
      { entity: 2, attribute: "child", value: 4 },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find all parent-child pairs with names
    const query: DatalogQuery = {
      find: ["?parentName", "?childName"],
      where: [
        { entity: "?parent", attribute: "name", value: "?parentName" },
        { entity: "?parent", attribute: "child", value: "?child" },
        { entity: "?child", attribute: "name", value: "?childName" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(3);
    const relationships = results.map((r) => [
      r["?parentName"],
      r["?childName"],
    ]);
    expect(relationships).toContainEqual(["Alice", "Bob"]);
    expect(relationships).toContainEqual(["Alice", "Charlie"]);
    expect(relationships).toContainEqual(["Bob", "Diana"]);

    await db.close();
  });

  test("should handle many-to-many relationships", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    // Create students and courses with enrollments
    await db.add([
      // Students
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
      // Courses
      { entity: 10, attribute: "title", value: "Math 101" },
      { entity: 11, attribute: "title", value: "CS 101" },
      // Enrollments (many-to-many)
      { entity: 100, attribute: "student", value: 1 },
      { entity: 100, attribute: "course", value: 10 },
      { entity: 101, attribute: "student", value: 1 },
      { entity: 101, attribute: "course", value: 11 },
      { entity: 102, attribute: "student", value: 2 },
      { entity: 102, attribute: "course", value: 10 },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find all student-course pairs
    const query: DatalogQuery = {
      find: ["?studentName", "?courseTitle"],
      where: [
        { entity: "?enrollment", attribute: "student", value: "?student" },
        { entity: "?enrollment", attribute: "course", value: "?course" },
        { entity: "?student", attribute: "name", value: "?studentName" },
        { entity: "?course", attribute: "title", value: "?courseTitle" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(3);
    const enrollments = results.map((r) => [
      r["?studentName"],
      r["?courseTitle"],
    ]);
    expect(enrollments).toContainEqual(["Alice", "Math 101"]);
    expect(enrollments).toContainEqual(["Alice", "CS 101"]);
    expect(enrollments).toContainEqual(["Bob", "Math 101"]);

    await db.close();
  });

  test("should handle queries with multiple constraints on same entity", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 1, attribute: "age", value: 30 },
      { entity: 1, attribute: "city", value: "NYC" },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 2, attribute: "age", value: 25 },
      { entity: 2, attribute: "city", value: "NYC" },
      { entity: 3, attribute: "name", value: "Charlie" },
      { entity: 3, attribute: "age", value: 30 },
      { entity: 3, attribute: "city", value: "LA" },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find people in NYC who are 30 years old
    const query: DatalogQuery = {
      find: ["?name"],
      where: [
        { entity: "?person", attribute: "name", value: "?name" },
        { entity: "?person", attribute: "age", value: 30 },
        { entity: "?person", attribute: "city", value: "NYC" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(1);
    expect(results[0]["?name"]).toBe("Alice");

    await db.close();
  });

  test("should handle complex variable bindings across multiple clauses", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    // Create a network of connections
    await db.add([
      { entity: 1, attribute: "name", value: "Node1" },
      { entity: 2, attribute: "name", value: "Node2" },
      { entity: 3, attribute: "name", value: "Node3" },
      { entity: 4, attribute: "name", value: "Node4" },
      // Connections: 1->2, 2->3, 3->4, 1->4
      { entity: 1, attribute: "connects", value: 2 },
      { entity: 2, attribute: "connects", value: 3 },
      { entity: 3, attribute: "connects", value: 4 },
      { entity: 1, attribute: "connects", value: 4 },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find all paths of length 2: A -> B -> C
    const query: DatalogQuery = {
      find: ["?a", "?b", "?c"],
      where: [
        { entity: "?a", attribute: "connects", value: "?b" },
        { entity: "?b", attribute: "connects", value: "?c" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(2); // 1->2->3 and 2->3->4
    const paths = results.map((r) => [r["?a"], r["?b"], r["?c"]]);
    expect(paths).toContainEqual([1, 2, 3]);
    expect(paths).toContainEqual([2, 3, 4]);

    await db.close();
  });

  test("should handle queries with ordering on multiple variables", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 1, attribute: "score", value: 100 },
      { entity: 1, attribute: "age", value: 30 },
      { entity: 2, attribute: "name", value: "Bob" },
      { entity: 2, attribute: "score", value: 100 },
      { entity: 2, attribute: "age", value: 25 },
      { entity: 3, attribute: "name", value: "Charlie" },
      { entity: 3, attribute: "score", value: 200 },
      { entity: 3, attribute: "age", value: 30 },
    ]);

    const engine = new DatalogQueryEngine(db);
    // Find all people, ordered by score (desc) then age (asc)
    const query: DatalogQuery = {
      find: ["?name", "?score", "?age"],
      where: [
        { entity: "?person", attribute: "name", value: "?name" },
        { entity: "?person", attribute: "score", value: "?score" },
        { entity: "?person", attribute: "age", value: "?age" },
      ],
      orderBy: [
        { variable: "?score", direction: "desc" },
        { variable: "?age", direction: "asc" },
      ],
    };

    const results = await engine.query(query);
    expect(results).toHaveLength(3);
    expect(results[0]["?score"]).toBe(200); // Charlie first (highest score)
    expect(results[1]["?score"]).toBe(100); // Bob second (same score, younger)
    expect(results[1]["?age"]).toBe(25);
    expect(results[2]["?score"]).toBe(100); // Alice third (same score, older)
    expect(results[2]["?age"]).toBe(30);

    await db.close();
  });
});
