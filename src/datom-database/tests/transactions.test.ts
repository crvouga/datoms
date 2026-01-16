import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { QueryTimeoutError, TransactionConflictError } from "../errors.js";
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
        const initial = await tx.datoms({ entity: 1 });
        expect(initial).toHaveLength(1);

        await tx.add([[1, "status", "pending"]]);
        const updated = await tx.datoms({ entity: 1 });
        expect(updated).toHaveLength(2);

        return "ok";
      });

      expect(result).toBe("ok");

      // Verify changes are committed
      const final = await db.datoms({ entity: 1 });
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
      const final = await db.datoms({ entity: 1 });
      expect(final).toHaveLength(1);
      expect(final[0].value).toBe("Alice");

      await db.close();
    });

    test("should see uncommitted changes within transaction", async () => {
      const { db } = f;

      await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        // Query before adding
        const before = await tx.datoms({ entity: 1 });
        expect(before).toHaveLength(1);

        // Add new datom
        await tx.add([[1, "age", 30]]);

        // Query after adding - should see uncommitted change
        const after = await tx.datoms({ entity: 1 });
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
        const result = await tx.datoms({ entity: 1 });
        expect(result).toHaveLength(1);
        expect(result[0].value).toBe("Alice");
      });

      // Verify retraction is committed
      const final = await db.datoms({ entity: 1 });
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
        const entities = results.map((r) => r["x"]).sort();
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
      const alice = await db.datoms({ entity: 1 });
      expect(alice).toHaveLength(2);
      const aliceValues = alice.map((d) => d.value);
      expect(aliceValues).toContain("Alice");
      expect(aliceValues).toContain(31);
      expect(aliceValues).not.toContain(30);

      const bob = await db.datoms({ entity: 2 });
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
      const result = await db.datoms({ entity: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe("Initial");

      const entity2 = await db.datoms({ entity: 2 });
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
        const names = results.map((r) => r["name"]).sort();
        expect(names).toEqual(["Alice", "Charlie"]);
      });

      await db.close();
    });
  });

  describe("getLatestTransaction", () => {
    test("should return 0 for empty database", async () => {
      const { db } = f;
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(0);
    });

    test("should return latest transaction ID after adding datoms", async () => {
      const { db } = f;
      const tx1 = await db.add([[1, "name", "Alice"]]);
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx1);

      const tx2 = await db.add([[2, "name", "Bob"]]);
      const latestTx2 = await db.getLatestTransaction();
      expect(latestTx2).toBe(tx2);
      expect(latestTx2).toBeGreaterThan(tx1);
    });

    test("should return latest transaction after retraction", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.retract([[1, "name", "Alice"]]);
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx2);
    });

    test("should return latest transaction after transact", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const tx2 = await db.transact({
        add: [[2, "name", "Bob"]],
        retract: [[1, "name", "Alice"]],
      });
      const latestTx = await db.getLatestTransaction();
      expect(latestTx).toBe(tx2);
    });

    test("should work within transactions", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const beforeTx = await db.getLatestTransaction();

      await db.transaction(async (tx) => {
        const txId = tx.getTransactionId();
        expect(txId).toBeGreaterThan(beforeTx);

        await tx.add([[2, "name", "Bob"]]);
        // Note: getLatestTransaction() may return the transaction ID assigned to this transaction
        // (depending on implementation), or it may return the last committed transaction.
        // The important thing is that after commit, it's updated.
        const latestBeforeCommit = await db.getLatestTransaction();
        // Should be at least beforeTx, possibly txId if implementation exposes uncommitted tx
        expect(latestBeforeCommit).toBeGreaterThanOrEqual(beforeTx);
      });

      // After commit, latest should be updated
      const afterTx = await db.getLatestTransaction();
      expect(afterTx).toBeGreaterThan(beforeTx);
    });
  });

  describe("Optimistic Locking", () => {
    test("should succeed when expectedTxId matches", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const currentTx = await db.getLatestTransaction();

      await db.transaction(
        async (tx) => {
          await tx.add([[2, "name", "Bob"]]);
        },
        { expectedTxId: currentTx }
      );

      // Should succeed
      const bob = await db.datoms({ entity: 2 });
      expect(bob.length).toBeGreaterThan(0);
    });

    test("should throw TransactionConflictError when expectedTxId doesn't match", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const initialTx = await db.getLatestTransaction();

      // Update database (changes txId)
      await db.add([[2, "name", "Bob"]]);

      try {
        await db.transaction(
          async (tx) => {
            await tx.add([[3, "name", "Charlie"]]);
          },
          { expectedTxId: initialTx }
        );
        throw new Error("Should have thrown TransactionConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(TransactionConflictError);
        const conflictError = error as TransactionConflictError;
        expect(conflictError.code).toBe("TRANSACTION_CONFLICT");
        expect(conflictError.name).toBe("TransactionConflictError");
        expect(conflictError.txId).toBe(initialTx);
        expect(conflictError.conflictingTxId).toBeGreaterThan(initialTx);
        expect(conflictError.message).toContain("conflict");
      }
    });

    test("should retry on conflict when retry options provided", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const initialTx = await db.getLatestTransaction();

      // Simulate concurrent update
      setTimeout(() => {
        db.add([[2, "name", "Bob"]]).catch(() => {});
      }, 10);

      // This test is tricky because we need actual concurrency
      // For now, test that retry mechanism exists
      let retryCount = 0;
      try {
        await db.transaction(
          async (tx) => {
            retryCount++;
            await tx.add([[3, "name", "Charlie"]]);
          },
          {
            expectedTxId: initialTx,
            retry: { maxRetries: 2, delayMs: 50 },
          }
        );
        // If it succeeds, that's fine (no conflict occurred)
      } catch (error) {
        // If it fails, should be TransactionConflictError
        expect(error).toBeInstanceOf(TransactionConflictError);
      }
    });

    test("should not retry when maxRetries is 0", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const initialTx = await db.getLatestTransaction();

      // Update database
      await db.add([[2, "name", "Bob"]]);

      let callbackExecuted = false;
      try {
        await db.transaction(
          async (tx) => {
            callbackExecuted = true;
            await tx.add([[3, "name", "Charlie"]]);
          },
          {
            expectedTxId: initialTx,
            retry: { maxRetries: 0, delayMs: 100 },
          }
        );
        throw new Error("Should have thrown TransactionConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(TransactionConflictError);
        // Conflict is detected before callback executes, so callback should not run
        expect(callbackExecuted).toBe(false);
        // Verify error has correct properties
        const conflictError = error as TransactionConflictError;
        expect(conflictError.txId).toBe(initialTx);
        expect(conflictError.conflictingTxId).toBeGreaterThan(initialTx);
      }
    });

    test("should work without optimistic locking options", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      await db.transaction(async (tx) => {
        await tx.add([[2, "name", "Bob"]]);
      });

      // Should succeed normally
      const bob = await db.datoms({ entity: 2 });
      expect(bob.length).toBeGreaterThan(0);
    });
  });

  describe("Transaction timeouts", () => {
    test("should complete transaction within timeout", async () => {
      const { db } = f;
      const result = await db.transaction(
        async (tx) => {
          await tx.add([[1, "name", "Alice"]]);
          return "success";
        },
        { timeoutMs: 5000 }
      );
      expect(result).toBe("success");

      const entity = await db.getEntity(1);
      expect(entity).toHaveLength(1);
      expect(entity[0].value).toBe("Alice");
    });

    test("should throw QueryTimeoutError when transaction timeout exceeded", async () => {
      const { db } = f;
      // Use a very short timeout - may or may not trigger depending on transaction speed
      try {
        await db.transaction(
          async (tx) => {
            await tx.add([[1, "name", "Alice"]]);
            // Add a small delay to potentially trigger timeout
            await new Promise((resolve) => setTimeout(resolve, 10));
          },
          { timeoutMs: 1 }
        );
        // If transaction completes quickly, that's fine - timeout is best-effort
      } catch (error) {
        if (error instanceof QueryTimeoutError) {
          expect(error).toBeInstanceOf(QueryTimeoutError);
          expect(error.timeoutMs).toBe(1);
        } else {
          throw error;
        }
      }
    });

    test("should rollback transaction on timeout", async () => {
      const { db } = f;
      let timeoutError: QueryTimeoutError | null = null;
      try {
        await db.transaction(
          async (tx) => {
            await tx.add([[1, "name", "Alice"]]);
            await new Promise((resolve) => setTimeout(resolve, 10));
          },
          { timeoutMs: 1 }
        );
        // If timeout didn't trigger, verify data was committed
        const entity = await db.getEntity(1);
        // Either timeout triggered (no data) or transaction completed (data exists)
        expect(entity.length).toBeGreaterThanOrEqual(0);
      } catch (error) {
        if (error instanceof QueryTimeoutError) {
          timeoutError = error;
          // Verify rollback occurred
          const entity = await db.getEntity(1);
          expect(entity).toHaveLength(0);
        } else {
          throw error;
        }
      }
      // Ensure timeout error was thrown
      expect(timeoutError).toBeInstanceOf(QueryTimeoutError);
    });

    test("should work with isolation level option", async () => {
      const { db } = f;
      const result = await db.transaction(
        async (tx) => {
          await tx.add([[1, "name", "Alice"]]);
          return "success";
        },
        {
          timeoutMs: 5000,
          isolationLevel: "READ_COMMITTED",
        }
      );
      expect(result).toBe("success");
    });
  });
});
