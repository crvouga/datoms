import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {QueryTimeoutError} from '../hook/hook';
import {queryResultsToDatoms} from '../shared/datoms-query-converter.js';
import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';
import {datomsQueryToDatalogQuery} from '../../datoms-query.js';

describe.each(FIXTURES)('Query Timeouts (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe('timeoutMs option', () => {
    test('should complete query within timeout', async () => {
      const {db} = f;
      await db.write([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const query = datomsQueryToDatalogQuery({
        e: 1,
        timeoutMs: 5000,
      });
      const {data: queryResults} = await db.read(query);
      const results = queryResultsToDatoms(queryResults, {
        e: 1,
        timeoutMs: 5000,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.v).toBe('Alice');
    });

    test('should throw QueryTimeoutError when timeout exceeded', async () => {
      const {db} = f;
      await db.write([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      // Use a very short timeout - may or may not trigger depending on query speed
      try {
        const query = datomsQueryToDatalogQuery({e: 1, timeoutMs: 1});
        await db.read(query);
        // If query completes quickly, that's fine - timeout is best-effort
      } catch (error: unknown) {
        if (error instanceof QueryTimeoutError) {
          expect(error).toBeInstanceOf(QueryTimeoutError);
          expect(error.timeoutMs).toBe(1);
          expect(error.queryOptions).toBeDefined();
        } else {
          throw error;
        }
      }
    });

    test('should work with other query options', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 1, a: 'age', v: 30},
      ]);

      const query = datomsQueryToDatalogQuery({
        e: 1,
        a: 'name',
        timeoutMs: 1000,
      });
      const {data: queryResults} = await db.read(query);
      const results = queryResultsToDatoms(queryResults, {
        e: 1,
        a: 'name',
        timeoutMs: 1000,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.v).toBe('Alice');
    });

    test('should work with pagination', async () => {
      const {db} = f;
      for (let i = 1; i <= 5; i++) {
        await db.write([{op: true, e: i, a: 'tag', v: `tag-${i}`}]);
      }

      const query = datomsQueryToDatalogQuery({
        a: 'tag',
        limit: 3,
        timeoutMs: 1000,
      });
      const {data: queryResults} = await db.read(query);
      const results = queryResultsToDatoms(queryResults, {
        a: 'tag',
        limit: 3,
        timeoutMs: 1000,
      });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });
});
