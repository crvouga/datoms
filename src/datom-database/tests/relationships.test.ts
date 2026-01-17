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
    test("should handle multi-entity relationships (friendships)", async () => {
      const { db } = f;
      // Create people
      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 2, a: "name", v: "Bob" },
          { e: 3, a: "name", v: "Charlie" },
          // Friendships: Alice -> Bob, Bob -> Charlie
          { e: 10, a: "from", v: 1 },
          { e: 10, a: "to", v: 2 },
          { e: 10, a: "type", v: "friendship" },
          { e: 11, a: "from", v: 2 },
          { e: 11, a: "to", v: 3 },
          { e: 11, a: "type", v: "friendship" },
        ],
      });

      // Find all friendships: who is friends with whom

      const results = await db.query({
        find: ["?from", "?to"],
        where: [
          ["?f", "from", "?from"],
          ["?f", "to", "?to"],
          ["?f", "type", "friendship"],
        ],
      });

      expect(results).toHaveLength(2);
      const friendships = results.map((r) => [r["from"], r["to"]]);
      expect(friendships).toContainEqual([1, 2]);
      expect(friendships).toContainEqual([2, 3]);

      await db.close();
    });

    test("should handle transitive relationships (friends of friends)", async () => {
      const { db } = f;
      // Create people and friendships
      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 2, a: "name", v: "Bob" },
          { e: 3, a: "name", v: "Charlie" },
          { e: 4, a: "name", v: "Diana" },
          // Friendships: Alice -> Bob, Bob -> Charlie, Bob -> Diana
          { e: 10, a: "from", v: 1 },
          { e: 10, a: "to", v: 2 },
          { e: 11, a: "from", v: 2 },
          { e: 11, a: "to", v: 3 },
          { e: 12, a: "from", v: 2 },
          { e: 12, a: "to", v: 4 },
        ],
      });

      // Find friends of Alice's friends (friends of friends)
      const query: DatalogQuery = {
        find: ["?friendOfFriend"],
        where: [
          ["?f1", "from", 1],
          ["?f1", "to", "?friend"],
          ["?f2", "from", "?friend"],
          ["?f2", "to", "?friendOfFriend"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(2);
      const friendOfFriends = results.map((r) => r["friendOfFriend"]).sort();
      expect(friendOfFriends).toEqual([3, 4]);

      await db.close();
    });

    test("should handle parent-child relationships", async () => {
      const { db } = f;
      // Create a family tree
      await db.transact({
        add: [
          { e: 1, a: "name", v: "Alice" },
          { e: 2, a: "name", v: "Bob" },
          { e: 3, a: "name", v: "Charlie" },
          { e: 4, a: "name", v: "Diana" },
          // Alice is parent of Bob and Charlie
          { e: 1, a: "child", v: 2 },
          { e: 1, a: "child", v: 3 },
          // Bob is parent of Diana
          { e: 2, a: "child", v: 4 },
        ],
      });

      // Find all parent-child pairs with names
      const query: DatalogQuery = {
        find: ["?parentName", "?childName"],
        where: [
          ["?parent", "name", "?parentName"],
          ["?parent", "child", "?child"],
          ["?child", "name", "?childName"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(3);
      const relationships = results.map((r) => [
        r["parentName"],
        r["childName"],
      ]);
      expect(relationships).toContainEqual(["Alice", "Bob"]);
      expect(relationships).toContainEqual(["Alice", "Charlie"]);
      expect(relationships).toContainEqual(["Bob", "Diana"]);

      await db.close();
    });

    test("should handle many-to-many relationships", async () => {
      const { db } = f;
      // Create students and courses with enrollments
      await db.transact({
        add: [
          // Students
          { e: 1, a: "name", v: "Alice" },
          { e: 2, a: "name", v: "Bob" },
          // Courses
          { e: 10, a: "title", v: "Math 101" },
          { e: 11, a: "title", v: "CS 101" },
          // Enrollments (many-to-many)
          { e: 100, a: "student", v: 1 },
          { e: 100, a: "course", v: 10 },
          { e: 101, a: "student", v: 1 },
          { e: 101, a: "course", v: 11 },
          { e: 102, a: "student", v: 2 },
          { e: 102, a: "course", v: 10 },
        ],
      });

      // Find all student-course pairs
      const query: DatalogQuery = {
        find: ["?studentName", "?courseTitle"],
        where: [
          ["?enrollment", "student", "?student"],
          ["?enrollment", "course", "?course"],
          ["?student", "name", "?studentName"],
          ["?course", "title", "?courseTitle"],
        ],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(3);
      const enrollments = results.map((r) => [
        r["studentName"],
        r["courseTitle"],
      ]);
      expect(enrollments).toContainEqual(["Alice", "Math 101"]);
      expect(enrollments).toContainEqual(["Alice", "CS 101"]);
      expect(enrollments).toContainEqual(["Bob", "Math 101"]);

      await db.close();
    });

    test("should handle multi-valued attributes", async () => {
      const { db } = f;
      await db.transact({
        add: [
          { e: 1, a: "tag", v: "red" },
          { e: 1, a: "tag", v: "blue" },
          { e: 1, a: "tag", v: "green" },
          { e: 2, a: "tag", v: "red" },
        ],
      });

      const query: DatalogQuery = {
        find: ["?e", "?tag"],
        where: [["?e", "tag", "?tag"]],
      };

      const results = await db.query(query);
      expect(results).toHaveLength(4);
      const entity1Tags = results
        .filter((r) => r["e"] === 1)
        .map((r) => r["tag"])
        .sort();
      expect(entity1Tags).toEqual(["blue", "green", "red"]);

      await db.close();
    });
  });
});
