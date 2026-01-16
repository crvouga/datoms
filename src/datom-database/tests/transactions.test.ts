import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

  describe("Transaction API", () => {
    test("should execute successful transaction", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      const result = await db.transaction(async (tx) => {
        const initial = await tx.query({ entity: 1 });
        expect(initial).toHaveLength(1);

        await tx.add([[1, "status", "pending"]]);
        const updated = await tx.query({ entity: 1 });
        expect(updated).toHaveLength(2);

        return "ok";
      });

      expect(result).toBe("ok");

      // Verify changes are committed
      const final = await db.query({ entity: 1 });
      expect(final).toHaveLength(2);
      const values = final.map((d) => d.value);
      expect(values).toContain("Alice");
      expect(values).toContain("pending");

      await db.close();
    });

    test("should rollback transaction on error", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      try {
        await db.transaction(async (tx) => {
          await tx.add([[1, "status", "pending"]]);
          throw new Error("rollback");
        });
        throw new Error("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("rollback");
      }

      // Verify changes were rolled back
      const final = await db.query({ entity: 1 });
      expect(final).toHaveLength(1);
      expect(final[0].value).toBe("Alice");

      await db.close();
    });

    test("should see uncommitted changes within transaction", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        // Query before adding
        const before = await tx.query({ entity: 1 });
        expect(before).toHaveLength(1);

        // Add new datom
        await tx.add([[1, "age", 30]]);

        // Query after adding - should see uncommitted change
        const after = await tx.query({ entity: 1 });
        expect(after).toHaveLength(2);
        const values = after.map((d) => d.value);
        expect(values).toContain("Alice");
        expect(values).toContain(30);
      });

      await db.close();
    });

    test("should handle retract within transaction", async () => {
      const { db } = f;

      await db.add([
        [1, "name", "Alice"],
        [1, "age", 30],
      ]);

      await db.transaction(async (tx) => {
        // Retract within transaction
        await tx.retract([[1, "age", 30]]);

        // Query should not see retracted datom
        const result = await tx.query({ entity: 1 });
        expect(result).toHaveLength(1);
        expect(result[0].value).toBe("Alice");
      });

      // Verify retraction is committed
      const final = await db.query({ entity: 1 });
      expect(final).toHaveLength(1);
      expect(final[0].value).toBe("Alice");

      await db.close();
    });

    test("should handle queryDatalog within transaction", async () => {
      const { db } = f;

      await db.add([
        [1, "name", "Alice"],
        [2, "name", "Bob"],
      ]);

      await db.transaction(async (tx) => {
        // Add within transaction
        await tx.add([[3, "name", "Charlie"]]);

        // Query should see uncommitted change
        const results = await tx.queryDatalog({
          find: ["?x"],
          where: [["?x", "name", "?y"]],
        });

        expect(results).toHaveLength(3);
        const entities = results.map((r) => r["?x"]).sort();
        expect(entities).toEqual([1, 2, 3]);
      });

      await db.close();
    });

    test("should handle multiple operations in transaction", async () => {
      const { db } = f;

      await db.transaction(async (tx) => {
        await tx.add([[1, "name", "Alice"]]);
        await tx.add([[1, "age", 30]]);
        await tx.add([[2, "name", "Bob"]]);
        await tx.retract([[1, "age", 30]]);
        await tx.add([[1, "age", 31]]);
      });

      // Verify all operations were applied
      const alice = await db.query({ entity: 1 });
      expect(alice).toHaveLength(2);
      const aliceValues = alice.map((d) => d.value);
      expect(aliceValues).toContain("Alice");
      expect(aliceValues).toContain(31);
      expect(aliceValues).not.toContain(30);

      const bob = await db.query({ entity: 2 });
      expect(bob).toHaveLength(1);
      expect(bob[0].value).toBe("Bob");

      await db.close();
    });

    test("should rollback all changes on error", async () => {
      const { db } = f;

      await db.add([[1, "name", "Initial"]]);

      try {
        await db.transaction(async (tx) => {
          await tx.add([[1, "status", "pending"]]);
          await tx.add([[2, "name", "New"]]);
          await tx.retract([[1, "name", "Initial"]]);
          throw new Error("fail");
        });
        throw new Error("Should have thrown");
      } catch (error) {
        // Expected
      }

      // Verify nothing changed
      const result = await db.query({ entity: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("Initial");

      const entity2 = await db.query({ entity: 2 });
      expect(entity2).toHaveLength(0);

      await db.close();
    });

    test("should handle getValue within transaction", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        const name = await tx.getValue(1, "name");
        expect(name).toBe("Alice");

        await tx.add([[1, "age", 30]]);
        const age = await tx.getValue(1, "age");
        expect(age).toBe(30);
      });

      await db.close();
    });

    test("should handle getEntity within transaction", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        let entity = await tx.getEntity(1);
        expect(entity).toHaveLength(1);

        await tx.add([[1, "age", 30]]);
        entity = await tx.getEntity(1);
        expect(entity).toHaveLength(2);
      });

      await db.close();
    });

    test("should handle hasFact within transaction", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        let hasName = await tx.hasFact(1, "name", "Alice");
        expect(hasName).toBe(true);

        await tx.add([[1, "status", "active"]]);
        const hasStatus = await tx.hasFact(1, "status", "active");
        expect(hasStatus).toBe(true);
      });

      await db.close();
    });

    test("should handle complex query within transaction", async () => {
      const { db } = f;

      await db.add([
        [1, "name", "Alice"],
        [1, "department", "Engineering"],
        [2, "name", "Bob"],
        [2, "department", "Sales"],
      ]);

      await db.transaction(async (tx) => {
        // Add new employee within transaction
        await tx.add([
          [3, "name", "Charlie"],
          [3, "department", "Engineering"],
        ]);

        // Query should see uncommitted change
        const results = await tx.queryDatalog({
          find: ["?name"],
          where: [
            ["?e", "name", "?name"],
            ["?e", "department", "Engineering"],
          ],
        });

        expect(results).toHaveLength(2);
        const names = results.map((r) => r["?name"]).sort();
        expect(names).toEqual(["Alice", "Charlie"]);
      });

      await db.close();
    });
  });
});
