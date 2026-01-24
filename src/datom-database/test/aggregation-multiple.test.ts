import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog/datalog.js';
import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';

describe.each(FIXTURES)('DatomDatabase (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe.todo('Multiple Aggregations', () => {
    test('should compute multiple aggregations in a single query', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 3, a: 'price', v: 300},
      ]);

      const {data: results} = await db.query({
        find: {
          total: {t: 'sum', c: '?price'},
          average: {t: 'avg', c: '?price'},
          maximum: {t: 'max', c: '?price', count: 1},
          minimum: {t: 'min', c: '?price', count: 1},
          count: {t: 'count', c: '?price'},
        },
        where: [{e: '?e', a: 'price', v: '?price'}],
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(600);
      expect(results[0]?.average).toBe(200);
      expect(results[0]?.maximum).toBe(300);
      expect(results[0]?.minimum).toBe(100);
      expect(results[0]?.count).toBe(3);
    });

    test('should compute statistical aggregations together', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
        {op: true, e: 4, a: 'value', v: 40},
        {op: true, e: 5, a: 'value', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {
          average: {t: 'avg', c: '?value'},
          median: {t: 'median', c: '?value'},
          variance: {t: 'variance', c: '?value'},
          stddev: {t: 'stddev', c: '?value'},
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBe(30);
      expect(results[0]?.median).toBe(30);
      expect(results[0]?.variance).toBeCloseTo(200, 1);
      expect(results[0]?.stddev).toBeCloseTo(14.14, 1);
    });

    test('should compute aggregations on different variables', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 1, a: 'quantity', v: 5},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 2, a: 'quantity', v: 3},
        {op: true, e: 3, a: 'price', v: 300},
        {op: true, e: 3, a: 'quantity', v: 2},
      ]);

      const query: DatalogQuery = {
        find: {
          totalPrice: {t: 'sum', c: '?price'},
          totalQuantity: {t: 'sum', c: '?quantity'},
          avgPrice: {t: 'avg', c: '?price'},
          maxQuantity: {t: 'max', c: '?quantity', count: 1},
        },
        where: [
          {e: '?e', a: 'price', v: '?price'},
          {e: '?e', a: 'quantity', v: '?quantity'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.totalPrice).toBe(600);
      expect(results[0]?.totalQuantity).toBe(10);
      expect(results[0]?.avgPrice).toBe(200);
      expect(results[0]?.maxQuantity).toBe(5);
    });

    test('should handle multiple aggregations with filters', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'type', v: 'product'},
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'type', v: 'product'},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 3, a: 'type', v: 'service'},
        {op: true, e: 3, a: 'price', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {
          count: {t: 'count', c: '?e'},
          total: {t: 'sum', c: '?price'},
          average: {t: 'avg', c: '?price'},
          maximum: {t: 'max', c: '?price', count: 1},
        },
        where: [
          {e: '?e', a: 'type', v: 'product'},
          {e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.count).toBe(2);
      expect(results[0]?.total).toBe(300);
      expect(results[0]?.average).toBe(150);
      expect(results[0]?.maximum).toBe(200);
    });

    test('should compute distinct and count-distinct together', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Alice'},
        {op: true, e: 4, a: 'name', v: 'Charlie'},
      ]);

      const query: DatalogQuery = {
        find: {
          distinctNames: {t: 'distinct', c: '?name'},
          distinctCount: {t: 'count-distinct', c: '?name'},
          totalCount: {t: 'count', c: '?name'},
        },
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.distinctCount).toBe(3);
      expect(results[0]?.totalCount).toBe(4);
      const distinctNames = results[0]?.distinctNames;
      if (Array.isArray(distinctNames)) {
        expect(distinctNames.length).toBe(3);
        expect([...distinctNames].sort()).toStrictEqual(['Alice', 'Bob', 'Charlie']);
      }
    });

    test('should handle empty results with multiple aggregations', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {
          total: {t: 'sum', c: '?price'},
          average: {t: 'avg', c: '?price'},
          maximum: {t: 'max', c: '?price', count: 1},
          minimum: {t: 'min', c: '?price', count: 1},
          count: {t: 'count', c: '?price'},
        },
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(0);
      expect(results[0]?.count).toBe(0);
      expect(
        results[0]?.average === null ||
          results[0]?.average === undefined ||
          results[0]?.average === 0,
      ).toBe(true);
      expect(results[0]?.maximum === null || results[0]?.maximum === undefined).toBe(true);
      expect(results[0]?.minimum === null || results[0]?.minimum === undefined).toBe(true);
    });

    test('should compute aggregations with sample and rand', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
        {op: true, e: 4, a: 'value', v: 40},
        {op: true, e: 5, a: 'value', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {
          sample: {t: 'sample', c: '?value', count: 3},
          random: {t: 'rand', c: '?value', count: 2},
          count: {t: 'count', c: '?value'},
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.count).toBe(5);
      const sample = results[0]?.sample;
      const random = results[0]?.random;
      expect(Array.isArray(sample)).toBe(true);
      expect(Array.isArray(random)).toBe(true);
      expect((sample as unknown as number[]).length).toBe(3);
      expect((random as unknown as number[]).length).toBe(2);
    });
  });
});
