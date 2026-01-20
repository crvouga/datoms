import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog/datalog.js';
import type {Fixture} from './fixtures/fixture.js';
import {FIXTURES} from './fixtures/fixtures.js';

describe.each(FIXTURES)('DatomDatabase (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe('Aggregation: max with default', () => {
    test('should find maximum value when values exist', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'age', v: 25},
        {op: 'assert', e: 2, a: 'age', v: 30},
        {op: 'assert', e: 3, a: 'age', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', 0, '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['maximum']).toBe(30);
    });

    test('should return default value for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {maximum: ['max', 0, '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Should return the default value when no results
      expect(results[0]!['maximum']).toBe(0);
    });

    test('should find maximum of single value', async () => {
      const {db} = f;
      await db.transact([{op: 'assert', e: 1, a: 'price', v: 100}]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '0', '?price']},
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['maximum']).toBe(100);
    });

    test('should find maximum with numeric default', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'value', v: 10},
        {op: 'assert', e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '100', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['maximum']).toBe(20);
    });

    test('should use default when all values are filtered out', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'type', v: 'product'},
        {op: 'assert', e: 1, a: 'price', v: 100},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '0', '?price']},
        where: [
          {e: '?e', a: 'type', v: 'service'},
          {e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['maximum']).toBe(0);
    });

    test('should find maximum with string default', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'name', v: 'Alice'},
        {op: 'assert', e: 2, a: 'name', v: 'Charlie'},
        {op: 'assert', e: 3, a: 'name', v: 'Bob'},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', 'A', '?name']},
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['maximum']).toBe('Charlie');
    });

    test('should handle default with different data types', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'value', v: 10},
        {op: 'assert', e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', 'default', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Should return the maximum value (20) when values exist
      expect(results[0]!['maximum']).toBe(20);
    });
  });
});
