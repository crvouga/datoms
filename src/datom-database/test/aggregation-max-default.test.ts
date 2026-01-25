import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog-query.js';
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

  describe.todo('Aggregation: max with default', () => {
    test('should find maximum value when values exist', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'age', v: 25},
        {op: true, e: 2, a: 'age', v: 30},
        {op: true, e: 3, a: 'age', v: 20},
      ]);

      const found = await db.read({
        find: {maximum: {t: 'max', c: '?age', count: 1}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(30);
    });

    test('should return default value for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {maximum: {t: 'max', c: '?age', count: 0}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Should return the default value when no results
      expect(results[0]?.maximum).toBe(0);
    });

    test('should find maximum of single value', async () => {
      const {db} = f;
      await db.write([{op: true, e: 1, a: 'price', v: 100}]);

      const query: DatalogQuery = {
        find: {maximum: {t: 'max', c: '?price', count: 0}},
        where: [{t: 'match', e: '?e', a: 'price', v: '?price'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(100);
    });

    test('should find maximum with numeric default', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: {t: 'max', c: '?value', count: 100}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(20);
    });

    test('should use default when all values are filtered out', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'type', v: 'product'},
        {op: true, e: 1, a: 'price', v: 100},
      ]);

      const query: DatalogQuery = {
        find: {maximum: {t: 'max', c: '?price', count: 0}},
        where: [
          {t: 'match', e: '?e', a: 'type', v: 'service'},
          {t: 'match', e: '?e', a: 'price', v: '?price'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(0);
    });

    test('should find maximum with string default', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Charlie'},
        {op: true, e: 3, a: 'name', v: 'Bob'},
      ]);

      const query: DatalogQuery = {
        find: {maximum: {t: 'max', c: '?name', count: 1}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?name'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe('Charlie');
    });

    test('should handle default with different data types', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: {t: 'max', c: '?value', count: 1}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Should return the maximum value (20) when values exist
      expect(results[0]?.maximum).toBe(20);
    });
  });
});
