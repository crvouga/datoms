import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';
import {
  QueryError,
  TransactionError,
  type AfterRead,
  type AfterWrite,
  type BeforeRead,
  type BeforeWrite,
} from '../hook/hook.js';
import {queryResultsToDatoms} from '../shared/datoms-query-converter.js';
import {HookValidator} from '../hook/validator.js';
import {datomsQueryToDatalogQuery} from '../../datoms-query.js';

describe.each(FIXTURES)('Hook Functionality (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe('Hook Registration', () => {
    test('should register before-read hook', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      let called = false;
      const hook: BeforeRead = {
        type: 'beforeRead',
        name: 'test-hook',
        execute: async query => {
          called = true;
          return {query};
        },
      };

      db.hook(hook);
      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '?e', a: 'name', v: 'Alice'}],
      });

      expect(called).toBe(true);
    });

    test('should register after-read hook', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      let called = false;
      const hook: AfterRead = {
        type: 'afterRead',
        name: 'test-hook',
        execute: async results => {
          called = true;
          return {results};
        },
      };

      db.hook(hook);
      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '1', a: 'name', v: '?v'}],
      });

      expect(called).toBe(true);
    });

    test('should register before-write hook', async () => {
      const {db} = f;

      let called = false;
      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'test-hook',
        execute: async tx => {
          called = true;
          return {tx};
        },
      };

      db.hook(hook);
      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      expect(called).toBe(true);
    });

    test('should register after-write hook', async () => {
      const {db} = f;

      let called = false;
      const hook: AfterWrite = {
        type: 'afterWrite',
        name: 'test-hook',
        execute: async () => {
          called = true;
        },
      };

      db.hook(hook);
      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      // Wait a bit for async after-write hooks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(called).toBe(true);
    });
  });

  describe('Before-Read Hooks', () => {
    test('should modify query before execution', async () => {
      const {db} = f;

      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '2', a: 'name', v: 'Bob'},
      ]);

      const hook: BeforeRead = {
        type: 'beforeRead',
        name: 'modify-query',
        execute: async query => {
          // Modify query to only find entity 1
          return {
            query: {
              ...query,
              where: [{t: 'match', e: '1', a: 'name', v: '?v'}],
            },
          };
        },
      };

      db.hook(hook);
      const found = await db.read({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?v'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.v).toBe('Alice');
    });

    test('should block query with errors', async () => {
      const {db} = f;

      const hook: BeforeRead = {
        type: 'beforeRead',
        name: 'block-query',
        execute: async () => {
          return {
            query: {find: {}, where: []},
            errors: [{message: 'Query not allowed', code: 'BLOCKED'}],
          };
        },
      };

      db.hook(hook);

      await expect(
        db.read({
          find: {e: {t: 'identity', c: '?e'}},
          where: [{t: 'match', e: '?e', a: 'name', v: 'Alice'}],
        }),
      ).rejects.toThrow(QueryError);
    });

    test('should stop processing on stopProcessing flag', async () => {
      const {db} = f;

      let firstCalled = false;
      let secondCalled = false;

      const hook1: BeforeRead = {
        type: 'beforeRead',
        name: 'first',
        execute: async query => {
          firstCalled = true;
          return {query, stopProcessing: true};
        },
      };

      const hook2: BeforeRead = {
        type: 'beforeRead',
        name: 'second',
        execute: async query => {
          secondCalled = true;
          return {query};
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '?e', a: 'name', v: 'Alice'}],
      });

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(false);
    });

    test('should pass context to before-read hook', async () => {
      const {db} = f;

      let receivedContext: Record<string, unknown> | undefined;

      const hook: BeforeRead = {
        type: 'beforeRead',
        name: 'context-test',
        execute: async (query, _ctx) => {
          receivedContext = query.context;
          return {query};
        },
      };

      db.hook(hook);

      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '?e', a: 'name', v: 'Alice'}],
        context: {userId: 'alice', source: 'test'},
      });

      expect(receivedContext).toBeDefined();
      expect(receivedContext?.userId).toBe('alice');
      expect(receivedContext?.source).toBe('test');
      expect(receivedContext?.db).toBeDefined();
    });
  });

  describe('After-Read Hooks', () => {
    test('should filter query results', async () => {
      const {db} = f;

      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '2', a: 'name', v: 'Bob'},
        {op: true, e: '3', a: 'name', v: 'Alice'},
      ]);

      const hook: AfterRead = {
        type: 'afterRead',
        name: 'filter-results',
        execute: async results => {
          // Filter to only return results with value "Alice"
          return {results: results.filter(r => r.v === 'Alice')};
        },
      };

      db.hook(hook);

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?v'}],
      });
      const results = found.data;
      expect(results).toHaveLength(2);
      expect(results.every(r => r.v === 'Alice')).toBe(true);
    });

    test('should filter datoms results', async () => {
      const {db} = f;

      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '2', a: 'name', v: 'Bob'},
        {op: true, e: '3', a: 'name', v: 'Alice'},
      ]);

      const hook: AfterRead = {
        type: 'afterRead',
        name: 'filter-results',
        execute: async results => {
          // Filter to only return results with value "Alice"
          return {results: results.filter(r => (r as {v?: unknown}).v === 'Alice')};
        },
      };

      db.hook(hook);

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?v'}],
      });
      const results = found.data;
      expect(results).toHaveLength(2);
      expect(results.every(r => (r as {v?: unknown}).v === 'Alice')).toBe(true);
    });

    test('should transform query results', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      const hook: AfterRead = {
        type: 'afterRead',
        name: 'transform-results',
        execute: async results => {
          // Transform query results
          return {
            results: results.map(r => ({
              ...r,
              // Hook can modify query results
            })),
          };
        },
      };

      db.hook(hook);

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '1', a: 'name', v: '?v'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
    });

    test('should chain multiple after-read hooks', async () => {
      const {db} = f;

      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '2', a: 'name', v: 'Bob'},
        {op: true, e: '3', a: 'name', v: 'Charlie'},
      ]);

      const hook1: AfterRead = {
        type: 'afterRead',
        name: 'filter-1',
        execute: async results => {
          return {results: results.filter(r => r.e !== '3')};
        },
      };

      const hook2: AfterRead = {
        type: 'afterRead',
        name: 'filter-2',
        execute: async results => {
          return {results: results.filter(r => r.v !== 'Bob')};
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?v'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.e).toBe('1');
    });

    test('should register before-read hook', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      let called = false;
      const hook: BeforeRead = {
        type: 'beforeRead',
        name: 'test-hook',
        execute: async query => {
          called = true;
          return {query};
        },
      };

      db.hook(hook);
      await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          a: {t: 'identity', c: '?a'},
          v: {t: 'identity', c: '?v'},
        },
        where: [{t: 'match', e: '1', a: '?a', v: '?v'}],
      });

      expect(called).toBe(true);
    });

    test('should register after-read hook', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      let called = false;
      const hook: AfterRead = {
        type: 'afterRead',
        name: 'test-hook',
        execute: async results => {
          called = true;
          return {results};
        },
      };

      db.hook(hook);
      await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          a: {t: 'identity', c: '?a'},
          v: {t: 'identity', c: '?v'},
        },
        where: [{t: 'match', e: '1', a: '?a', v: '?v'}],
      });

      expect(called).toBe(true);
    });

    test('should modify query with before-read hook', async () => {
      const {db} = f;

      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '2', a: 'name', v: 'Bob'},
      ]);

      const hook: BeforeRead = {
        type: 'beforeRead',
        name: 'modify-query',
        execute: async query => {
          // Modify query to only return entity 1
          return {
            query: {
              ...query,
              where: [{t: 'match', e: '1', a: 'name', v: '?v'}],
            },
          };
        },
      };

      db.hook(hook);

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?v'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.e).toBe('1');
    });

    test('should pass context to after-read hook', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      let receivedContext: Record<string, unknown> | undefined;

      const hook: AfterRead = {
        type: 'afterRead',
        name: 'context-test',
        execute: async (results, ctx) => {
          receivedContext = ctx.query.context;
          return {results};
        },
      };

      db.hook(hook);

      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '1', a: 'name', v: '?v'}],
        context: {userId: 'alice', source: 'test'},
      });

      expect(receivedContext).toBeDefined();
      expect(receivedContext?.userId).toBe('alice');
      expect(receivedContext?.source).toBe('test');
      expect(receivedContext?.db).toBeDefined();
    });
  });

  describe('Before-Write Hooks', () => {
    test('should validate transaction', async () => {
      const {db} = f;

      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'validate-email',
        execute: async tx => {
          const validator = new HookValidator();
          for (const datom of tx.datoms) {
            if (datom.a === 'email') {
              const email = String(datom.v);
              validator.true(email.includes('@'), 'Invalid email format', 'INVALID_EMAIL', datom);
            }
          }

          if (validator.hasErrors()) {
            return {tx, errors: validator.getErrors()};
          }
          return {tx};
        },
      };

      db.hook(hook);

      // Valid email should succeed
      await db.write([{op: true, e: '1', a: 'email', v: 'alice@example.com'}]);

      // Invalid email should fail
      await expect(db.write([{op: true, e: '2', a: 'email', v: 'invalid-email'}])).rejects.toThrow(
        TransactionError,
      );
    });

    test('should modify transaction', async () => {
      const {db} = f;

      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'add-timestamp',
        execute: async tx => {
          // Add a timestamp to all datoms
          const modifiedDatoms = tx.datoms.map(d => ({
            ...d,
            // Note: We can't modify tx directly, but we can add new datoms
          }));

          // Add a new datom for timestamp
          modifiedDatoms.push({
            e: tx.datoms[0]?.e || '0',
            a: 'updatedAt',
            v: new Date().toISOString(),
            tx: tx.datoms[0]?.tx || 0,
            op: true,
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

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      const query = datomsQueryToDatalogQuery({e: '1'});
      const found = await db.read(query);
      const results = found.data;
      const datoms = queryResultsToDatoms(results, {e: '1'});
      const hasTimestamp = datoms.some(d => d.a === 'updatedAt');
      expect(hasTimestamp).toBe(true);
    });

    test('should stop processing on stopProcessing flag', async () => {
      const {db} = f;

      let firstCalled = false;
      let secondCalled = false;

      const hook1: BeforeWrite = {
        type: 'beforeWrite',
        name: 'first',
        execute: async tx => {
          firstCalled = true;
          return {tx, stopProcessing: true};
        },
      };

      const hook2: BeforeWrite = {
        type: 'beforeWrite',
        name: 'second',
        execute: async tx => {
          secondCalled = true;
          return {tx};
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(false);
    });

    test('should pass context and metadata to before-write hook', async () => {
      const {db} = f;

      let receivedContext: Record<string, unknown> | undefined;

      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'context-test',
        execute: async (tx, ctx) => {
          receivedContext = ctx as Record<string, unknown>;
          return {tx};
        },
      };

      db.hook(hook);

      await db.write(
        [{op: true, e: '1', a: 'name', v: 'Alice'}],
        {userId: 'alice', reason: 'test'},
        {source: 'client', ip: '127.0.0.1'},
      );

      expect(receivedContext).toBeDefined();
      expect((receivedContext?.txMeta as {userId?: string})?.userId).toBe('alice');
      expect((receivedContext?.txMeta as {reason?: string})?.reason).toBe('test');
      expect(receivedContext?.source).toBe('client');
      expect(receivedContext?.ip).toBe('127.0.0.1');
      expect(receivedContext?.db).toBeDefined();
    });

    test('should collect multiple errors from hooks', async () => {
      const {db} = f;

      const hook1: BeforeWrite = {
        type: 'beforeWrite',
        name: 'validator-1',
        execute: async tx => {
          const validator = new HookValidator();
          validator.true(tx.datoms.length > 0, 'No datoms in transaction', 'EMPTY_TX');
          return {tx, errors: validator.getErrors()};
        },
      };

      const hook2: BeforeWrite = {
        type: 'beforeWrite',
        name: 'validator-2',
        execute: async tx => {
          const validator = new HookValidator();
          for (const datom of tx.datoms) {
            if (datom.a === 'age') {
              validator.true(
                typeof datom.v === 'number' && datom.v > 0,
                'Age must be positive',
                'INVALID_AGE',
                datom,
              );
            }
          }
          return {tx, errors: validator.getErrors()};
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      // This should pass (no errors)
      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      // This should fail with age validation error
      await expect(db.write([{op: true, e: '2', a: 'age', v: -5}])).rejects.toThrow(
        TransactionError,
      );
    });
  });

  describe('After-Write Hooks', () => {
    test('should execute after successful transaction', async () => {
      const {db} = f;

      let called = false;
      let receivedTx: unknown;

      const hook: AfterWrite = {
        type: 'afterWrite',
        name: 'side-effect',
        execute: async result => {
          called = true;
          receivedTx = result;
        },
      };

      db.hook(hook);

      void (await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]));

      // Wait for async after-write hooks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(called).toBe(true);
      expect(receivedTx).toBeDefined();
      expect((receivedTx as {datoms: unknown[]; txId: unknown}).datoms).toBeDefined();
      expect((receivedTx as {txId: unknown}).txId).toBeDefined();
    });

    test('should not block transaction on failure', async () => {
      const {db} = f;

      const hook: AfterWrite = {
        type: 'afterWrite',
        name: 'failing-hook',
        execute: async () => {
          throw new Error('Side effect failed');
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
        void (await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]));

        // Wait for async after-write hooks to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        // Verify transaction succeeded
        const query = datomsQueryToDatalogQuery({e: '1'});
        const found = await db.read(query);
        const results = found.data;
        const datoms = queryResultsToDatoms(results, {e: '1'});
        expect(datoms).toHaveLength(1);
      } finally {
        // Restore console.error
        console.error = originalConsoleError;
      }
    });

    test('should execute multiple after-write hooks', async () => {
      const {db} = f;

      const executionOrder: string[] = [];

      const hook1: AfterWrite = {
        type: 'afterWrite',
        name: 'first',
        execute: async () => {
          executionOrder.push('first');
        },
      };

      const hook2: AfterWrite = {
        type: 'afterWrite',
        name: 'second',
        execute: async () => {
          executionOrder.push('second');
        },
      };

      db.hook(hook1);
      db.hook(hook2);

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      // Wait for async after-write hooks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(executionOrder.length).toBeGreaterThanOrEqual(2);
    });

    test('should pass context and metadata to after-write hook', async () => {
      const {db} = f;

      let receivedContext: Record<string, unknown> | undefined;

      const hook: AfterWrite = {
        type: 'afterWrite',
        name: 'context-test',
        execute: async (_result, ctx) => {
          receivedContext = ctx as Record<string, unknown>;
        },
      };

      db.hook(hook);

      await db.write(
        [{op: true, e: '1', a: 'name', v: 'Alice'}],
        {userId: 'alice', reason: 'test'},
        {source: 'client', ip: '127.0.0.1'},
      );

      // Wait for async after-write hooks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(receivedContext).toBeDefined();
      expect((receivedContext?.txMeta as {userId?: string})?.userId).toBe('alice');
      expect((receivedContext?.txMeta as {reason?: string})?.reason).toBe('test');
      expect(receivedContext?.source).toBe('client');
      expect(receivedContext?.ip).toBe('127.0.0.1');
      expect(receivedContext?.db).toBeDefined();
    });
  });

  describe('HookValidator', () => {
    test('should collect errors', () => {
      const validator = new HookValidator();

      validator.true(false, 'Error 1', 'CODE1');
      validator.true(true, 'Error 2', 'CODE2');
      validator.true(false, 'Error 3', 'CODE3');

      expect(validator.hasErrors()).toBe(true);
      const errors = validator.getErrors();
      expect(errors).toHaveLength(2);
      expect(errors?.[0]?.message).toBe('Error 1');
      expect(errors?.[0]?.code).toBe('CODE1');
      expect(errors?.[1]?.message).toBe('Error 3');
      expect(errors?.[1]?.code).toBe('CODE3');
    });

    test('should return undefined when no errors', () => {
      const validator = new HookValidator();

      validator.true(true, 'Error 1', 'CODE1');
      validator.true(true, 'Error 2', 'CODE2');

      expect(validator.hasErrors()).toBe(false);
      expect(validator.getErrors()).toBeUndefined();
    });

    test('should associate errors with datoms', () => {
      const validator = new HookValidator();
      const datom = {
        e: '1',
        a: 'email',
        v: 'invalid',
        tx: 1,
        op: true,
      };

      validator.true(false, 'Invalid email', 'INVALID_EMAIL', datom);

      const errors = validator.getErrors();
      expect(errors?.[0]?.datom).toBe(datom);
    });
  });

  describe('Complex Hook Scenarios', () => {
    test('should handle read and write hooks together', async () => {
      const {db} = f;

      let readCalled = false;
      let writeCalled = false;

      const readHook: BeforeRead = {
        type: 'beforeRead',
        name: 'read-logger',
        execute: async query => {
          readCalled = true;
          return {query};
        },
      };

      const writeHook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'write-logger',
        execute: async tx => {
          writeCalled = true;
          return {tx};
        },
      };

      db.hook(readHook);
      db.hook(writeHook);

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);
      expect(writeCalled).toBe(true);

      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '1', a: 'name', v: '?v'}],
      });
      expect(readCalled).toBe(true);
    });

    test('should handle hook errors with proper error structure', async () => {
      const {db} = f;

      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'error-test',
        execute: async tx => {
          return {
            tx,
            errors: [
              {
                message: 'Validation failed',
                code: 'VALIDATION_ERROR',
                datom: tx.datoms[0],
              },
              {
                message: 'Another error',
                code: 'ANOTHER_ERROR',
              },
            ],
          };
        },
      };

      db.hook(hook);

      try {
        await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);
        throw new Error('Should have thrown TransactionError');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TransactionError);
        if (error instanceof TransactionError) {
          expect(error.errors).toHaveLength(2);
          expect(error.errors[0]?.hook).toBe('error-test');
          expect(error.errors[0]?.message).toBe('Validation failed');
          expect(error.errors[0]?.code).toBe('VALIDATION_ERROR');
          expect(error.errors[1]?.message).toBe('Another error');
        }
      }
    });

    test('should execute hooks in registration order', async () => {
      const {db} = f;

      const executionOrder: string[] = [];

      const hook1: BeforeWrite = {
        type: 'beforeWrite',
        name: 'first',
        execute: async tx => {
          executionOrder.push('first');
          return {tx};
        },
      };

      const hook2: BeforeWrite = {
        type: 'beforeWrite',
        name: 'second',
        execute: async tx => {
          executionOrder.push('second');
          return {tx};
        },
      };

      const hook3: BeforeWrite = {
        type: 'beforeWrite',
        name: 'third',
        execute: async tx => {
          executionOrder.push('third');
          return {tx};
        },
      };

      db.hook(hook1);
      db.hook(hook2);
      db.hook(hook3);

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      expect(executionOrder).toEqual(['first', 'second', 'third']);
    });

    test('should handle empty transaction with hooks', async () => {
      const {db} = f;

      let called = false;
      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'empty-tx-handler',
        execute: async tx => {
          called = true;
          expect(tx.datoms).toHaveLength(0);
          return {tx};
        },
      };

      db.hook(hook);

      // Empty transaction (should still create a transaction ID)
      await db.write([]);

      expect(called).toBe(true);
    });

    test('should handle sub operations with hooks', async () => {
      const {db} = f;

      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      let called = false;
      const hook: BeforeWrite = {
        type: 'beforeWrite',
        name: 'sub-handler',
        execute: async tx => {
          called = true;
          const subs = tx.datoms.filter(d => d.op === false);
          expect(subs.length).toBeGreaterThan(0);
          return {tx};
        },
      };

      db.hook(hook);

      await db.write([{op: false, e: '1', a: 'name', v: 'Alice'}]);

      expect(called).toBe(true);
      const query = datomsQueryToDatalogQuery({e: '1'});
      const found = await db.read(query);
      const results = found.data;
      const datoms = queryResultsToDatoms(results, {e: '1'});
      expect(datoms).toHaveLength(0);
    });

    test('should call appropriate hooks for query() method', async () => {
      const {db} = f;

      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '2', a: 'name', v: 'Bob'},
      ]);

      let queryBeforeReadCalled = false;
      let queryAfterReadCalled = false;

      const queryBeforeHook: BeforeRead = {
        type: 'beforeRead',
        name: 'query-before',
        execute: async query => {
          queryBeforeReadCalled = true;
          return {query};
        },
      };

      const queryAfterHook: AfterRead = {
        type: 'afterRead',
        name: 'query-after',
        execute: async results => {
          queryAfterReadCalled = true;
          return {results};
        },
      };

      // Register hooks
      db.hook(queryBeforeHook);
      db.hook(queryAfterHook);

      // Call query() - should trigger query hooks
      await db.read({
        find: {e: {t: 'identity', c: '?e'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?v'}],
      });

      expect(queryBeforeReadCalled).toBe(true);
      expect(queryAfterReadCalled).toBe(true);
    });
  });
});
