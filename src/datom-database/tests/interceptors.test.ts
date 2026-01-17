import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  AfterReadInterceptor,
  BeforeReadInterceptor,
  BeforeWriteInterceptor,
  AfterWriteInterceptor,
} from "../interceptor-types.js";
import { InterceptorValidator } from "../interceptor-validator.js";
import { QueryError, TransactionError } from "../errors.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)(
  "Interceptor Functionality (%s)",
  (_name, createFixture) => {
    let f: Fixture;

    beforeEach(async () => {
      f = await createFixture();
      await f.beforeEach();
    });

    afterEach(async () => {
      await f.afterEach();
    });

    describe("Interceptor Registration", () => {
      test("should register before-read interceptor", async () => {
        const { db } = f;

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        let called = false;
        const interceptor: BeforeReadInterceptor = {
          type: "beforeRead",
          name: "test-interceptor",
          execute: async (query) => {
            called = true;
            return { query };
          },
        };

        db.interceptors.register(interceptor);
        await db.query({
          find: { e: ["?e"] },
          where: [{ e: "?e", a: "name", v: "Alice" }],
        });

        expect(called).toBe(true);
        await db.close();
      });

      test("should register after-read interceptor", async () => {
        const { db } = f;

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        let called = false;
        const interceptor: AfterReadInterceptor = {
          type: "afterRead",
          name: "test-interceptor",
          execute: async (datoms) => {
            called = true;
            return datoms;
          },
        };

        db.interceptors.register(interceptor);
        await db.query({
          find: { e: ["?e"] },
          where: [{ e: 1, a: "name", v: "?v" }],
        });

        expect(called).toBe(true);
        await db.close();
      });

      test("should register before-write interceptor", async () => {
        const { db } = f;

        let called = false;
        const interceptor: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "test-interceptor",
          execute: async (tx) => {
            called = true;
            return { tx };
          },
        };

        db.interceptors.register(interceptor);
        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        expect(called).toBe(true);
        await db.close();
      });

      test("should register after-write interceptor", async () => {
        const { db } = f;

        let called = false;
        const interceptor: AfterWriteInterceptor = {
          type: "afterWrite",
          name: "test-interceptor",
          execute: async () => {
            called = true;
          },
        };

        db.interceptors.register(interceptor);
        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        // Wait a bit for async after-write interceptors
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(called).toBe(true);
        await db.close();
      });
    });

    describe("Before-Read Interceptors", () => {
      test("should modify query before execution", async () => {
        const { db } = f;

        await db.transact([
          { op: "add", e: 1, a: "name", v: "Alice" },
          { op: "add", e: 2, a: "name", v: "Bob" },
        ]);

        const interceptor: BeforeReadInterceptor = {
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

        db.interceptors.register(interceptor);
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

        const interceptor: BeforeReadInterceptor = {
          type: "beforeRead",
          name: "block-query",
          execute: async () => {
            return {
              query: { find: {}, where: [] },
              errors: [{ message: "Query not allowed", code: "BLOCKED" }],
            };
          },
        };

        db.interceptors.register(interceptor);

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

        const interceptor1: BeforeReadInterceptor = {
          type: "beforeRead",
          name: "first",
          execute: async (query) => {
            firstCalled = true;
            return { query, stopProcessing: true };
          },
        };

        const interceptor2: BeforeReadInterceptor = {
          type: "beforeRead",
          name: "second",
          execute: async (query) => {
            secondCalled = true;
            return { query };
          },
        };

        db.interceptors.register(interceptor1);
        db.interceptors.register(interceptor2);

        await db.query({
          find: { e: ["?e"] },
          where: [{ e: "?e", a: "name", v: "Alice" }],
        });

        expect(firstCalled).toBe(true);
        expect(secondCalled).toBe(false);
        await db.close();
      });

      test("should pass context to before-read interceptor", async () => {
        const { db } = f;

        let receivedContext: Record<string, unknown> | undefined;

        const interceptor: BeforeReadInterceptor = {
          type: "beforeRead",
          name: "context-test",
          execute: async (query, ctx) => {
            receivedContext = ctx as Record<string, unknown>;
            return { query };
          },
        };

        db.interceptors.register(interceptor);

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

    describe("After-Read Interceptors", () => {
      test("should filter results", async () => {
        const { db } = f;

        await db.transact([
          { op: "add", e: 1, a: "name", v: "Alice" },
          { op: "add", e: 2, a: "name", v: "Bob" },
          { op: "add", e: 3, a: "name", v: "Alice" },
        ]);

        const interceptor: AfterReadInterceptor = {
          type: "afterRead",
          name: "filter-results",
          execute: async (datoms) => {
            // Filter to only return datoms with value "Alice"
            return datoms.filter((d) => d.v === "Alice");
          },
        };

        db.interceptors.register(interceptor);

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

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        const interceptor: AfterReadInterceptor = {
          type: "afterRead",
          name: "transform-results",
          execute: async (datoms) => {
            // Add a transformed attribute (though this won't affect query results directly)
            // This demonstrates the interceptor can modify the datoms array
            return datoms.map((d) => ({
              ...d,
              // Note: This transformation happens before projection, so it affects
              // the datoms used for projection
            }));
          },
        };

        db.interceptors.register(interceptor);

        const results = await db.query({
          find: { e: ["?e"] },
          where: [{ e: 1, a: "name", v: "?v" }],
        });

        expect(results).toHaveLength(1);
        await db.close();
      });

      test("should chain multiple after-read interceptors", async () => {
        const { db } = f;

        await db.transact([
          { op: "add", e: 1, a: "name", v: "Alice" },
          { op: "add", e: 2, a: "name", v: "Bob" },
          { op: "add", e: 3, a: "name", v: "Charlie" },
        ]);

        const interceptor1: AfterReadInterceptor = {
          type: "afterRead",
          name: "filter-1",
          execute: async (datoms) => {
            return datoms.filter((d) => d.e !== 3);
          },
        };

        const interceptor2: AfterReadInterceptor = {
          type: "afterRead",
          name: "filter-2",
          execute: async (datoms) => {
            return datoms.filter((d) => d.v !== "Bob");
          },
        };

        db.interceptors.register(interceptor1);
        db.interceptors.register(interceptor2);

        const results = await db.query({
          find: { e: ["?e"] },
          where: [{ e: "?e", a: "name", v: "?v" }],
        });

        expect(results).toHaveLength(1);
        expect(results[0].e).toBe(1);
        await db.close();
      });

      test("should pass context to after-read interceptor", async () => {
        const { db } = f;

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        let receivedContext: Record<string, unknown> | undefined;

        const interceptor: AfterReadInterceptor = {
          type: "afterRead",
          name: "context-test",
          execute: async (datoms, ctx) => {
            receivedContext = ctx as Record<string, unknown>;
            return datoms;
          },
        };

        db.interceptors.register(interceptor);

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

    describe("Before-Write Interceptors", () => {
      test("should validate transaction", async () => {
        const { db } = f;

        const interceptor: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "validate-email",
          execute: async (tx) => {
            const validator = new InterceptorValidator();
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

        db.interceptors.register(interceptor);

        // Valid email should succeed
        await db.transact([
          { op: "add", e: 1, a: "email", v: "alice@example.com" },
        ]);

        // Invalid email should fail
        await expect(
          db.transact([{ op: "add", e: 2, a: "email", v: "invalid-email" }])
        ).rejects.toThrow(TransactionError);

        await db.close();
      });

      test("should modify transaction", async () => {
        const { db } = f;

        const interceptor: BeforeWriteInterceptor = {
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
              op: "add",
            });

            return {
              tx: {
                ...tx,
                datoms: modifiedDatoms,
              },
            };
          },
        };

        db.interceptors.register(interceptor);

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        const datoms = await db.datoms({ e: 1 });
        const hasTimestamp = datoms.some((d) => d.a === "updatedAt");
        expect(hasTimestamp).toBe(true);
        await db.close();
      });

      test("should stop processing on stopProcessing flag", async () => {
        const { db } = f;

        let firstCalled = false;
        let secondCalled = false;

        const interceptor1: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "first",
          execute: async (tx) => {
            firstCalled = true;
            return { tx, stopProcessing: true };
          },
        };

        const interceptor2: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "second",
          execute: async (tx) => {
            secondCalled = true;
            return { tx };
          },
        };

        db.interceptors.register(interceptor1);
        db.interceptors.register(interceptor2);

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        expect(firstCalled).toBe(true);
        expect(secondCalled).toBe(false);
        await db.close();
      });

      test("should pass context and metadata to before-write interceptor", async () => {
        const { db } = f;

        let receivedContext: Record<string, unknown> | undefined;

        const interceptor: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "context-test",
          execute: async (tx, ctx) => {
            receivedContext = ctx as Record<string, unknown>;
            return { tx };
          },
        };

        db.interceptors.register(interceptor);

        await db.transact(
          [{ op: "add", e: 1, a: "name", v: "Alice" }],
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

      test("should collect multiple errors from interceptors", async () => {
        const { db } = f;

        const interceptor1: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "validator-1",
          execute: async (tx) => {
            const validator = new InterceptorValidator();
            validator.assert(
              tx.datoms.length > 0,
              "No datoms in transaction",
              "EMPTY_TX"
            );
            return { tx, errors: validator.getErrors() };
          },
        };

        const interceptor2: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "validator-2",
          execute: async (tx) => {
            const validator = new InterceptorValidator();
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

        db.interceptors.register(interceptor1);
        db.interceptors.register(interceptor2);

        // This should pass (no errors)
        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        // This should fail with age validation error
        await expect(
          db.transact([{ op: "add", e: 2, a: "age", v: -5 }])
        ).rejects.toThrow(TransactionError);

        await db.close();
      });
    });

    describe("After-Write Interceptors", () => {
      test("should execute after successful transaction", async () => {
        const { db } = f;

        let called = false;
        let receivedTx: unknown;

        const interceptor: AfterWriteInterceptor = {
          type: "afterWrite",
          name: "side-effect",
          execute: async (tx) => {
            called = true;
            receivedTx = tx;
          },
        };

        db.interceptors.register(interceptor);

        const txId = await db.transact([
          { op: "add", e: 1, a: "name", v: "Alice" },
        ]);

        // Wait for async after-write interceptors
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(called).toBe(true);
        expect(receivedTx).toBeDefined();
        expect((receivedTx as { datoms: unknown[] }).datoms).toBeDefined();
        await db.close();
      });

      test("should not block transaction on failure", async () => {
        const { db } = f;

        const interceptor: AfterWriteInterceptor = {
          type: "afterWrite",
          name: "failing-interceptor",
          execute: async () => {
            throw new Error("Side effect failed");
          },
        };

        db.interceptors.register(interceptor);

        // Suppress console.error for this test since we expect the error
        const originalConsoleError = console.error;
        console.error = () => {
          // Suppress error output during test
        };

        try {
          // Transaction should succeed even if after-write interceptor fails
          const txId = await db.transact([
            { op: "add", e: 1, a: "name", v: "Alice" },
          ]);

          // Wait for async after-write interceptors to complete
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

      test("should execute multiple after-write interceptors", async () => {
        const { db } = f;

        const executionOrder: string[] = [];

        const interceptor1: AfterWriteInterceptor = {
          type: "afterWrite",
          name: "first",
          execute: async () => {
            executionOrder.push("first");
          },
        };

        const interceptor2: AfterWriteInterceptor = {
          type: "afterWrite",
          name: "second",
          execute: async () => {
            executionOrder.push("second");
          },
        };

        db.interceptors.register(interceptor1);
        db.interceptors.register(interceptor2);

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        // Wait for async after-write interceptors
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(executionOrder.length).toBeGreaterThanOrEqual(2);
        await db.close();
      });

      test("should pass context and metadata to after-write interceptor", async () => {
        const { db } = f;

        let receivedContext: Record<string, unknown> | undefined;

        const interceptor: AfterWriteInterceptor = {
          type: "afterWrite",
          name: "context-test",
          execute: async (tx, ctx) => {
            receivedContext = ctx as Record<string, unknown>;
          },
        };

        db.interceptors.register(interceptor);

        await db.transact(
          [{ op: "add", e: 1, a: "name", v: "Alice" }],
          { userId: "alice", reason: "test" },
          { source: "client", ip: "127.0.0.1" }
        );

        // Wait for async after-write interceptors
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

    describe("InterceptorValidator", () => {
      test("should collect errors", () => {
        const validator = new InterceptorValidator();

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
        const validator = new InterceptorValidator();

        validator.assert(true, "Error 1", "CODE1");
        validator.assert(true, "Error 2", "CODE2");

        expect(validator.hasErrors()).toBe(false);
        expect(validator.getErrors()).toBeUndefined();
      });

      test("should associate errors with datoms", () => {
        const validator = new InterceptorValidator();
        const datom = {
          e: 1,
          a: "email",
          v: "invalid",
          tx: 1,
          op: "add" as const,
        };

        validator.assert(false, "Invalid email", "INVALID_EMAIL", datom);

        const errors = validator.getErrors();
        expect(errors?.[0]?.datom).toBe(datom);
      });
    });

    describe("Complex Interceptor Scenarios", () => {
      test("should handle read and write interceptors together", async () => {
        const { db } = f;

        let readCalled = false;
        let writeCalled = false;

        const readInterceptor: BeforeReadInterceptor = {
          type: "beforeRead",
          name: "read-logger",
          execute: async (query) => {
            readCalled = true;
            return { query };
          },
        };

        const writeInterceptor: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "write-logger",
          execute: async (tx) => {
            writeCalled = true;
            return { tx };
          },
        };

        db.interceptors.register(readInterceptor);
        db.interceptors.register(writeInterceptor);

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
        expect(writeCalled).toBe(true);

        await db.query({
          find: { e: ["?e"] },
          where: [{ e: 1, a: "name", v: "?v" }],
        });
        expect(readCalled).toBe(true);

        await db.close();
      });

      test("should handle interceptor errors with proper error structure", async () => {
        const { db } = f;

        const interceptor: BeforeWriteInterceptor = {
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

        db.interceptors.register(interceptor);

        try {
          await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
          throw new Error("Should have thrown TransactionError");
        } catch (error) {
          expect(error).toBeInstanceOf(TransactionError);
          if (error instanceof TransactionError) {
            expect(error.errors).toHaveLength(2);
            expect(error.errors[0].interceptor).toBe("error-test");
            expect(error.errors[0].message).toBe("Validation failed");
            expect(error.errors[0].code).toBe("VALIDATION_ERROR");
            expect(error.errors[1].message).toBe("Another error");
          }
        }

        await db.close();
      });

      test("should execute interceptors in registration order", async () => {
        const { db } = f;

        const executionOrder: string[] = [];

        const interceptor1: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "first",
          execute: async (tx) => {
            executionOrder.push("first");
            return { tx };
          },
        };

        const interceptor2: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "second",
          execute: async (tx) => {
            executionOrder.push("second");
            return { tx };
          },
        };

        const interceptor3: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "third",
          execute: async (tx) => {
            executionOrder.push("third");
            return { tx };
          },
        };

        db.interceptors.register(interceptor1);
        db.interceptors.register(interceptor2);
        db.interceptors.register(interceptor3);

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        expect(executionOrder).toEqual(["first", "second", "third"]);
        await db.close();
      });

      test("should handle empty transaction with interceptors", async () => {
        const { db } = f;

        let called = false;
        const interceptor: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "empty-tx-handler",
          execute: async (tx) => {
            called = true;
            expect(tx.datoms).toHaveLength(0);
            return { tx };
          },
        };

        db.interceptors.register(interceptor);

        // Empty transaction (should still create a transaction ID)
        await db.transact([]);

        expect(called).toBe(true);
        await db.close();
      });

      test("should handle sub operations with interceptors", async () => {
        const { db } = f;

        await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);

        let called = false;
        const interceptor: BeforeWriteInterceptor = {
          type: "beforeWrite",
          name: "sub-handler",
          execute: async (tx) => {
            called = true;
            const subs = tx.datoms.filter((d) => d.op === "sub");
            expect(subs.length).toBeGreaterThan(0);
            return { tx };
          },
        };

        db.interceptors.register(interceptor);

        await db.transact([{ op: "sub", e: 1, a: "name", v: "Alice" }]);

        expect(called).toBe(true);
        const datoms = await db.datoms({ e: 1 });
        expect(datoms).toHaveLength(0);
        await db.close();
      });
    });
  }
);
