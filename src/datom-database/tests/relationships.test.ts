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
      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
        [3, "name", "Charlie"],
        // Friendships: Alice -> Bob, Bob -> Charlie
        [10, "from", 1],
        [10, "to", 2],
        [10, "type", "friendship"],
        [11, "from", 2],
        [11, "to", 3],
        [11, "type", "friendship"],
      ]);

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
      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
        [3, "name", "Charlie"],
        [4, "name", "Diana"],
        // Friendships: Alice -> Bob, Bob -> Charlie, Bob -> Diana
        [10, "from", 1],
        [10, "to", 2],
        [11, "from", 2],
        [11, "to", 3],
        [12, "from", 2],
        [12, "to", 4],
      ]);

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
      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
        [3, "name", "Charlie"],
        [4, "name", "Diana"],
        // Alice is parent of Bob and Charlie
        [1, "child", 2],
        [1, "child", 3],
        // Bob is parent of Diana
        [2, "child", 4],
      ]);

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
      await db.add([
        // Students
        [1, "name", "Alice"],
        [2, "name", "Bob"],
        // Courses
        [10, "title", "Math 101"],
        [11, "title", "CS 101"],
        // Enrollments (many-to-many)
        [100, "student", 1],
        [100, "course", 10],
        [101, "student", 1],
        [101, "course", 11],
        [102, "student", 2],
        [102, "course", 10],
      ]);

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
      await db.add([
        [1, "tag", "red"],
        [1, "tag", "blue"],
        [1, "tag", "green"],
        [2, "tag", "red"],
      ]);

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
