import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import {QueryResultSizeError} from '../hook/hook';
import {queryResultsToDatoms} from '../shared/datoms-query-converter.js';
import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';
import {datomsQueryToDatalogQuery} from '../../datoms-query.js';

describe.each(FIXTURES)('Query Result Size Limits (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe('maxResultSize option', () => {
    test('should allow queries within limit', async () => {
      const {db} = f;
      for (let i = 1; i <= 5; i++) {
        await db.write([{op: true, e: String(i), a: 'tag', v: `tag-${i}`}]);
      }

      const query = datomsQueryToDatalogQuery({
        a: 'tag',
        maxResultSize: 10,
      });
      const {data: queryResults} = await db.read(query);
      const results = queryResultsToDatoms(queryResults, {
        a: 'tag',
        maxResultSize: 10,
      });
      expect(results.length).toBeLessThanOrEqual(10);
    });

    test('should throw QueryResultSizeError when limit exceeded', async () => {
      const {db} = f;
      // Add more datoms than the limit
      for (let i = 1; i <= 10; i++) {
        await db.write([{op: true, e: String(i), a: 'tag', v: `tag-${i}`}]);
      }

      try {
        const query = datomsQueryToDatalogQuery({a: 'tag', maxResultSize: 5});
        await db.read(query);
        throw new Error('Should have thrown QueryResultSizeError');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(QueryResultSizeError);
        const sizeError = error as QueryResultSizeError;
        expect(sizeError.resultSize).toBeGreaterThan(5);
        expect(sizeError.maxResultSize).toBe(5);
        expect(sizeError.queryOptions).toBeDefined();
      }
    });

    test('should work with limit option', async () => {
      const {db} = f;
      for (let i = 1; i <= 10; i++) {
        await db.write([{op: true, e: String(i), a: 'tag', v: `tag-${i}`}]);
      }

      // limit should be applied first, then maxResultSize check
      const query = datomsQueryToDatalogQuery({
        a: 'tag',
        limit: 3,
        maxResultSize: 5,
      });
      const {data: queryResults} = await db.read(query);
      const results = queryResultsToDatoms(queryResults, {
        a: 'tag',
        limit: 3,
        maxResultSize: 5,
      });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    test('should work with filters', async () => {
      const {db} = f;
      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      const query = datomsQueryToDatalogQuery({
        e: '1',
        maxResultSize: 10,
      });
      const {data: queryResults} = await db.read(query);
      const results = queryResultsToDatoms(queryResults, {
        e: '1',
        maxResultSize: 10,
      });
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });
});
