import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fixture, FIXTURES } from "../../test/fixtures.npm-ignore.js";
import {
  AfterRead,
  AfterWrite,
  BeforeRead,
  BeforeWrite,
  QueryError,
  TransactionError,
} from "../hook/hook.js";
import { HookValidator } from "../hook/validator.js";

describe.each(FIXTURES)("Hook Functionality (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("Hook Registration", () => {
    test("should register before-read hook", async () => {
      const { db } = f;

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      let called = false;
      const hook: BeforeRead = {
        type: "beforeRead",
        name: "test-hook",
        execute: async (query) => {
          called = true;
          return { query };
        },
      };

      db.hook(hook);
      await db.query({
        find: { e: ["?e"] },
        where: [{ e: "?e", a: "name", v: "Alice" }],
      });

      expect(called).toBe(true);
      await db.close();
    });

    test("should register after-read hook", async () => {
      const { db } = f;

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      let called = false;
      const hook: AfterRead = {
        type: "afterRead",
        name: "test-hook",
        execute: async (datoms) => {
          called = true;
          return { datoms };
        },
      };

      db.hook(hook);
      await db.query({
        find: { e: ["?e"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });

      expect(called).toBe(true);
      await db.close();
    });

    test("should register before-write hook", async () => {
      const { db } = f;

      let called = false;
      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "test-hook",
        execute: async (tx) => {
          called = true;
          return { tx };
        },
      };

      db.hook(hook);
      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      expect(called).toBe(true);
      await db.close();
    });

    test("should register after-write hook", async () => {
      const { db } = f;

      let called = false;
      const hook: AfterWrite = {
        type: "afterWrite",
        name: "test-hook",
        execute: async () => {
          called = true;
        },
      };

      db.hook(hook);
      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      // Wait a bit for async after-write hooks
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(called).toBe(true);
      await db.close();
    });
  });

  describe("Before-Read Hooks", () => {
    test("should modify query before execution", async () => {
      const { db } = f;

      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
      ]);

      const hook: BeforeRead = {
        type: "beforeRead",
        name: "modify-query",
        execute: async (query) => {
          // Modify query to only find entity 1
          return {
            query: {
              ...query,
              where: [{ e: 1, a: "name", v: "?v" }],
            },
          };
        },
      };

      db.hook(hook);
      const results = await db.query({
        find: { v: ["?v"] },
        where: [{ e: "?e", a: "name", v: "?v" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].v).toBe("Alice");
      await db.close();
    });

    test("should block query with errors", async () => {
      const { db } = f;

      const hook: BeforeRead = {
        type: "beforeRead",
        name: "block-query",
        execute: async () => {
          return {
            query: { find: {}, where: [] },
            errors: [{ message: "Query not allowed", code: "BLOCKED" }],
          };
        },
      };

      db.hook(hook);

      await expect(
        db.query({
          find: { e: ["?e"] },
          where: [{ e: "?e", a: "name", v: "Alice" }],
        })
      ).rejects.toThrow(QueryError);

      await db.close();
    });

    test("should stop processing on stopProcessing flag", async () => {
      const { db } = f;

      let firstCalled = false;
      let secondCalled = false;

      const hook1: BeforeRead = {
        type: "beforeRead",
        name: "first",
        execute: async (query) => {
          firstCalled = true;
          return { query, stopProcessing: true };
        },
      };

      const hook2: BeforeRead = {
        type: "beforeRead",
        name: "second",
        execute: async (query) => {
          secondCalled = true;
          return { query };
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      await db.query({
        find: { e: ["?e"] },
        where: [{ e: "?e", a: "name", v: "Alice" }],
      });

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(false);
      await db.close();
    });

    test("should pass context to before-read hook", async () => {
      const { db } = f;

      let receivedContext: Record<string, unknown> | undefined;

      const hook: BeforeRead = {
        type: "beforeRead",
        name: "context-test",
        execute: async (query, ctx) => {
          receivedContext = ctx as Record<string, unknown>;
          return { query };
        },
      };

      db.hook(hook);

      await db.query(
        { find: { e: ["?e"] }, where: [{ e: "?e", a: "name", v: "Alice" }] },
        { userId: "alice", source: "test" }
      );

      expect(receivedContext).toBeDefined();
      expect(receivedContext?.userId).toBe("alice");
      expect(receivedContext?.source).toBe("test");
      expect(receivedContext?.db).toBe(db);
      await db.close();
    });
  });

  describe("After-Read Hooks", () => {
    test("should filter results", async () => {
      const { db } = f;

      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "name", v: "Alice" },
      ]);

      const hook: AfterRead = {
        type: "afterRead",
        name: "filter-results",
        execute: async (datoms) => {
          // Filter to only return datoms with value "Alice"
          return { datoms: datoms.filter((d) => d.v === "Alice") };
        },
      };

      db.hook(hook);

      const results = await db.query({
        find: { e: ["?e"], v: ["?v"] },
        where: [{ e: "?e", a: "name", v: "?v" }],
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.v === "Alice")).toBe(true);
      await db.close();
    });

    test("should transform results", async () => {
      const { db } = f;

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      const hook: AfterRead = {
        type: "afterRead",
        name: "transform-results",
        execute: async (datoms) => {
          // Add a transformed attribute (though this won't affect query results directly)
          // This demonstrates the hook can modify the datoms array
          return {
            datoms: datoms.map((d) => ({
              ...d,
              // Note: This transformation happens before projection, so it affects
              // the datoms used for projection
            })),
          };
        },
      };

      db.hook(hook);

      const results = await db.query({
        find: { e: ["?e"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });

      expect(results).toHaveLength(1);
      await db.close();
    });

    test("should chain multiple after-read hooks", async () => {
      const { db } = f;

      await db.transact([
        { op: "assert", e: 1, a: "name", v: "Alice" },
        { op: "assert", e: 2, a: "name", v: "Bob" },
        { op: "assert", e: 3, a: "name", v: "Charlie" },
      ]);

      const hook1: AfterRead = {
        type: "afterRead",
        name: "filter-1",
        execute: async (datoms) => {
          return { datoms: datoms.filter((d) => d.e !== 3) };
        },
      };

      const hook2: AfterRead = {
        type: "afterRead",
        name: "filter-2",
        execute: async (datoms) => {
          return { datoms: datoms.filter((d) => d.v !== "Bob") };
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      const results = await db.query({
        find: { e: ["?e"] },
        where: [{ e: "?e", a: "name", v: "?v" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].e).toBe(1);
      await db.close();
    });

    test("should pass context to after-read hook", async () => {
      const { db } = f;

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      let receivedContext: Record<string, unknown> | undefined;

      const hook: AfterRead = {
        type: "afterRead",
        name: "context-test",
        execute: async (datoms, ctx) => {
          receivedContext = ctx as Record<string, unknown>;
          return { datoms };
        },
      };

      db.hook(hook);

      await db.query(
        { find: { e: ["?e"] }, where: [{ e: 1, a: "name", v: "?v" }] },
        { userId: "alice", source: "test" }
      );

      expect(receivedContext).toBeDefined();
      expect(receivedContext?.userId).toBe("alice");
      expect(receivedContext?.source).toBe("test");
      expect(receivedContext?.db).toBe(db);
      await db.close();
    });
  });

  describe("Before-Write Hooks", () => {
    test("should validate transaction", async () => {
      const { db } = f;

      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "validate-email",
        execute: async (tx) => {
          const validator = new HookValidator();
          for (const datom of tx.datoms) {
            if (datom.a === "email") {
              const email = String(datom.v);
              validator.assert(
                email.includes("@"),
                "Invalid email format",
                "INVALID_EMAIL",
                datom
              );
            }
          }

          if (validator.hasErrors()) {
            return { tx, errors: validator.getErrors() };
          }
          return { tx };
        },
      };

      db.hook(hook);

      // Valid email should succeed
      await db.transact([
        { op: "assert", e: 1, a: "email", v: "alice@example.com" },
      ]);

      // Invalid email should fail
      await expect(
        db.transact([{ op: "assert", e: 2, a: "email", v: "invalid-email" }])
      ).rejects.toThrow(TransactionError);

      await db.close();
    });

    test("should modify transaction", async () => {
      const { db } = f;

      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "add-timestamp",
        execute: async (tx) => {
          // Add a timestamp to all datoms
          const modifiedDatoms = tx.datoms.map((d) => ({
            ...d,
            // Note: We can't modify tx directly, but we can add new datoms
          }));

          // Add a new datom for timestamp
          modifiedDatoms.push({
            e: tx.datoms[0]?.e || 0,
            a: "updatedAt",
            v: new Date().toISOString(),
            tx: tx.datoms[0]?.tx || 0,
            op: "assert",
          });

          return {
            tx: {
              ...tx,
              datoms: modifiedDatoms,
            },
          };
        },
      };

      db.hook(hook);

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      const datoms = await db.datoms({ e: 1 });
      const hasTimestamp = datoms.some((d) => d.a === "updatedAt");
      expect(hasTimestamp).toBe(true);
      await db.close();
    });

    test("should stop processing on stopProcessing flag", async () => {
      const { db } = f;

      let firstCalled = false;
      let secondCalled = false;

      const hook1: BeforeWrite = {
        type: "beforeWrite",
        name: "first",
        execute: async (tx) => {
          firstCalled = true;
          return { tx, stopProcessing: true };
        },
      };

      const hook2: BeforeWrite = {
        type: "beforeWrite",
        name: "second",
        execute: async (tx) => {
          secondCalled = true;
          return { tx };
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(false);
      await db.close();
    });

    test("should pass context and metadata to before-write hook", async () => {
      const { db } = f;

      let receivedContext: Record<string, unknown> | undefined;

      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "context-test",
        execute: async (tx, ctx) => {
          receivedContext = ctx as Record<string, unknown>;
          return { tx };
        },
      };

      db.hook(hook);

      await db.transact(
        [{ op: "assert", e: 1, a: "name", v: "Alice" }],
        { userId: "alice", reason: "test" },
        { source: "client", ip: "127.0.0.1" }
      );

      expect(receivedContext).toBeDefined();
      expect((receivedContext?.txMeta as { userId?: string })?.userId).toBe(
        "alice"
      );
      expect((receivedContext?.txMeta as { reason?: string })?.reason).toBe(
        "test"
      );
      expect(receivedContext?.source).toBe("client");
      expect(receivedContext?.ip).toBe("127.0.0.1");
      expect(receivedContext?.db).toBe(db);
      await db.close();
    });

    test("should collect multiple errors from hooks", async () => {
      const { db } = f;

      const hook1: BeforeWrite = {
        type: "beforeWrite",
        name: "validator-1",
        execute: async (tx) => {
          const validator = new HookValidator();
          validator.assert(
            tx.datoms.length > 0,
            "No datoms in transaction",
            "EMPTY_TX"
          );
          return { tx, errors: validator.getErrors() };
        },
      };

      const hook2: BeforeWrite = {
        type: "beforeWrite",
        name: "validator-2",
        execute: async (tx) => {
          const validator = new HookValidator();
          for (const datom of tx.datoms) {
            if (datom.a === "age") {
              validator.assert(
                typeof datom.v === "number" && datom.v > 0,
                "Age must be positive",
                "INVALID_AGE",
                datom
              );
            }
          }
          return { tx, errors: validator.getErrors() };
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      // This should pass (no errors)
      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      // This should fail with age validation error
      await expect(
        db.transact([{ op: "assert", e: 2, a: "age", v: -5 }])
      ).rejects.toThrow(TransactionError);

      await db.close();
    });
  });

  describe("After-Write Hooks", () => {
    test("should execute after successful transaction", async () => {
      const { db } = f;

      let called = false;
      let receivedTx: unknown;

      const hook: AfterWrite = {
        type: "afterWrite",
        name: "side-effect",
        execute: async (result) => {
          called = true;
          receivedTx = result;
        },
      };

      db.hook(hook);

      void (await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]));

      // Wait for async after-write hooks
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(called).toBe(true);
      expect(receivedTx).toBeDefined();
      expect(
        (receivedTx as { datoms: unknown[]; txId: unknown }).datoms
      ).toBeDefined();
      expect((receivedTx as { txId: unknown }).txId).toBeDefined();
      await db.close();
    });

    test("should not block transaction on failure", async () => {
      const { db } = f;

      const hook: AfterWrite = {
        type: "afterWrite",
        name: "failing-hook",
        execute: async () => {
          throw new Error("Side effect failed");
        },
      };

      db.hook(hook);

      // Suppress console.error for this test since we expect the error
      const originalConsoleError = console.error;
      console.error = () => {
        // Suppress error output during test
      };

      try {
        // Transaction should succeed even if after-write hook fails
        void (await db.transact([
          { op: "assert", e: 1, a: "name", v: "Alice" },
        ]));

        // Wait for async after-write hooks to complete
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Verify transaction succeeded
        const datoms = await db.datoms({ e: 1 });
        expect(datoms).toHaveLength(1);
      } finally {
        // Restore console.error
        console.error = originalConsoleError;
      }

      await db.close();
    });

    test("should execute multiple after-write hooks", async () => {
      const { db } = f;

      const executionOrder: string[] = [];

      const hook1: AfterWrite = {
        type: "afterWrite",
        name: "first",
        execute: async () => {
          executionOrder.push("first");
        },
      };

      const hook2: AfterWrite = {
        type: "afterWrite",
        name: "second",
        execute: async () => {
          executionOrder.push("second");
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      // Wait for async after-write hooks
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(executionOrder.length).toBeGreaterThanOrEqual(2);
      await db.close();
    });

    test("should pass context and metadata to after-write hook", async () => {
      const { db } = f;

      let receivedContext: Record<string, unknown> | undefined;

      const hook: AfterWrite = {
        type: "afterWrite",
        name: "context-test",
        execute: async (_result, ctx) => {
          receivedContext = ctx as Record<string, unknown>;
        },
      };

      db.hook(hook);

      await db.transact(
        [{ op: "assert", e: 1, a: "name", v: "Alice" }],
        { userId: "alice", reason: "test" },
        { source: "client", ip: "127.0.0.1" }
      );

      // Wait for async after-write hooks
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedContext).toBeDefined();
      expect((receivedContext?.txMeta as { userId?: string })?.userId).toBe(
        "alice"
      );
      expect((receivedContext?.txMeta as { reason?: string })?.reason).toBe(
        "test"
      );
      expect(receivedContext?.source).toBe("client");
      expect(receivedContext?.ip).toBe("127.0.0.1");
      expect(receivedContext?.db).toBe(db);
      await db.close();
    });
  });

  describe("HookValidator", () => {
    test("should collect errors", () => {
      const validator = new HookValidator();

      validator.assert(false, "Error 1", "CODE1");
      validator.assert(true, "Error 2", "CODE2");
      validator.assert(false, "Error 3", "CODE3");

      expect(validator.hasErrors()).toBe(true);
      const errors = validator.getErrors();
      expect(errors).toHaveLength(2);
      expect(errors?.[0]?.message).toBe("Error 1");
      expect(errors?.[0]?.code).toBe("CODE1");
      expect(errors?.[1]?.message).toBe("Error 3");
      expect(errors?.[1]?.code).toBe("CODE3");
    });

    test("should return undefined when no errors", () => {
      const validator = new HookValidator();

      validator.assert(true, "Error 1", "CODE1");
      validator.assert(true, "Error 2", "CODE2");

      expect(validator.hasErrors()).toBe(false);
      expect(validator.getErrors()).toBeUndefined();
    });

    test("should associate errors with datoms", () => {
      const validator = new HookValidator();
      const datom = {
        e: 1,
        a: "email",
        v: "invalid",
        tx: 1,
        op: "assert" as const,
      };

      validator.assert(false, "Invalid email", "INVALID_EMAIL", datom);

      const errors = validator.getErrors();
      expect(errors?.[0]?.datom).toBe(datom);
    });
  });

  describe("Complex Hook Scenarios", () => {
    test("should handle read and write hooks together", async () => {
      const { db } = f;

      let readCalled = false;
      let writeCalled = false;

      const readHook: BeforeRead = {
        type: "beforeRead",
        name: "read-logger",
        execute: async (query) => {
          readCalled = true;
          return { query };
        },
      };

      const writeHook: BeforeWrite = {
        type: "beforeWrite",
        name: "write-logger",
        execute: async (tx) => {
          writeCalled = true;
          return { tx };
        },
      };

      db.hook(readHook);
      db.hook(writeHook);

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);
      expect(writeCalled).toBe(true);

      await db.query({
        find: { e: ["?e"] },
        where: [{ e: 1, a: "name", v: "?v" }],
      });
      expect(readCalled).toBe(true);

      await db.close();
    });

    test("should handle hook errors with proper error structure", async () => {
      const { db } = f;

      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "error-test",
        execute: async (tx) => {
          return {
            tx,
            errors: [
              {
                message: "Validation failed",
                code: "VALIDATION_ERROR",
                datom: tx.datoms[0],
              },
              {
                message: "Another error",
                code: "ANOTHER_ERROR",
              },
            ],
          };
        },
      };

      db.hook(hook);

      try {
        await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);
        throw new Error("Should have thrown TransactionError");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TransactionError);
        if (error instanceof TransactionError) {
          expect(error.errors).toHaveLength(2);
          expect(error.errors[0].hook).toBe("error-test");
          expect(error.errors[0].message).toBe("Validation failed");
          expect(error.errors[0].code).toBe("VALIDATION_ERROR");
          expect(error.errors[1].message).toBe("Another error");
        }
      }

      await db.close();
    });

    test("should execute hooks in registration order", async () => {
      const { db } = f;

      const executionOrder: string[] = [];

      const hook1: BeforeWrite = {
        type: "beforeWrite",
        name: "first",
        execute: async (tx) => {
          executionOrder.push("first");
          return { tx };
        },
      };

      const hook2: BeforeWrite = {
        type: "beforeWrite",
        name: "second",
        execute: async (tx) => {
          executionOrder.push("second");
          return { tx };
        },
      };

      const hook3: BeforeWrite = {
        type: "beforeWrite",
        name: "third",
        execute: async (tx) => {
          executionOrder.push("third");
          return { tx };
        },
      };

      db.hook(hook1);
      db.hook(hook2);
      db.hook(hook3);

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      expect(executionOrder).toEqual(["first", "second", "third"]);
      await db.close();
    });

    test("should handle empty transaction with hooks", async () => {
      const { db } = f;

      let called = false;
      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "empty-tx-handler",
        execute: async (tx) => {
          called = true;
          expect(tx.datoms).toHaveLength(0);
          return { tx };
        },
      };

      db.hook(hook);

      // Empty transaction (should still create a transaction ID)
      await db.transact([]);

      expect(called).toBe(true);
      await db.close();
    });

    test("should handle sub operations with hooks", async () => {
      const { db } = f;

      await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);

      let called = false;
      const hook: BeforeWrite = {
        type: "beforeWrite",
        name: "sub-handler",
        execute: async (tx) => {
          called = true;
          const subs = tx.datoms.filter((d) => d.op === "retract");
          expect(subs.length).toBeGreaterThan(0);
          return { tx };
        },
      };

      db.hook(hook);

      await db.transact([{ op: "retract", e: 1, a: "name", v: "Alice" }]);

      expect(called).toBe(true);
      const datoms = await db.datoms({ e: 1 });
      expect(datoms).toHaveLength(0);
      await db.close();
    });
  });
});
