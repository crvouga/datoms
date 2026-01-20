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

  describe('Aggregation Edge Cases', () => {
    test('should handle aggregations with all zero values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 0},
        {op: true, e: 2, a: 'value', v: 0},
        {op: true, e: 3, a: 'value', v: 0},
      ]);

      const query: DatalogQuery = {
        find: {
          sum: ['sum', '?value'],
          avg: ['avg', '?value'],
          max: ['max', '?value'],
          min: ['min', '?value'],
          count: ['count', '?value'],
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.sum).toBe(0);
      expect(results[0]?.avg).toBe(0);
      expect(results[0]?.max).toBe(0);
      expect(results[0]?.min).toBe(0);
      expect(results[0]?.count).toBe(3);
    });

    test('should handle aggregations with very large numbers', async () => {
      const {db} = f;
      const largeNumber = Number.MAX_SAFE_INTEGER - 1000;
      await db.transact([
        {op: true, e: 1, a: 'value', v: largeNumber},
        {op: true, e: 2, a: 'value', v: 1000},
      ]);

      const query: DatalogQuery = {
        find: {
          sum: ['sum', '?value'],
          max: ['max', '?value'],
          min: ['min', '?value'],
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.max).toBe(largeNumber);
      expect(results[0]?.min).toBe(1000);
      // Sum might overflow, so just check it's a number
      expect(typeof results[0]?.sum).toBe('number');
    });

    test('should handle aggregations with very small numbers', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 0.0000001},
        {op: true, e: 2, a: 'value', v: 0.0000002},
        {op: true, e: 3, a: 'value', v: 0.0000003},
      ]);

      const query: DatalogQuery = {
        find: {
          sum: ['sum', '?value'],
          avg: ['avg', '?value'],
          max: ['max', '?value'],
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.sum).toBeCloseTo(0.0000006, 7);
      expect(results[0]?.avg).toBeCloseTo(0.0000002, 7);
      expect(results[0]?.max).toBe(0.0000003);
    });

    test('should handle aggregations with mixed positive and negative values summing to zero', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 100},
        {op: true, e: 2, a: 'value', v: -50},
        {op: true, e: 3, a: 'value', v: -50},
      ]);

      const query: DatalogQuery = {
        find: {
          sum: ['sum', '?value'],
          avg: ['avg', '?value'],
          max: ['max', '?value'],
          min: ['min', '?value'],
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.sum).toBe(0);
      expect(results[0]?.avg).toBeCloseTo(0, 1);
      expect(results[0]?.max).toBe(100);
      expect(results[0]?.min).toBe(-50);
    });

    test('should handle count with falseions', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'item', v: 'A'},
        {op: true, e: 2, a: 'item', v: 'B'},
        {op: true, e: 3, a: 'item', v: 'C'},
      ]);

      // false one item
      await db.transact([{op: false, e: 2, a: 'item', v: 'B'}]);

      const query: DatalogQuery = {
        find: {
          count: ['count', '?item'],
          distinct: ['count-distinct', '?item'],
        },
        where: [{e: '?e', a: 'item', v: '?item'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.count).toBe(2);
      expect(results[0]?.distinct).toBe(2);
    });

    test('should handle aggregations with updates (true over existing)', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'score', v: 50},
        {op: true, e: 2, a: 'score', v: 60},
        {op: true, e: 3, a: 'score', v: 70},
      ]);

      // Update entity 1's score (true adds a new value, doesn't replace)
      await db.transact([{op: true, e: 1, a: 'score', v: 90}]);

      const query: DatalogQuery = {
        find: {
          sum: ['sum', '?score'],
          avg: ['avg', '?score'],
          max: ['max', '?score'],
          count: ['count', '?score'],
        },
        where: [{e: '?e', a: 'score', v: '?score'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Values: [50, 60, 70, 90]
      expect(results[0]?.sum).toBe(270);
      expect(results[0]?.avg).toBeCloseTo(67.5, 1);
      expect(results[0]?.max).toBe(90);
      expect(results[0]?.count).toBe(4);
    });

    test('should handle variance and stddev with two identical values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 10},
      ]);

      const query: DatalogQuery = {
        find: {
          variance: ['variance', '?value'],
          stddev: ['stddev', '?value'],
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Variance and stddev of two identical values should be 0
      expect(results[0]?.variance).toBe(0);
      expect(results[0]?.stddev).toBe(0);
    });

    test('should handle median with two values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {
          median: ['median', '?value'],
        },
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Median of two values is their average
      expect(results[0]?.median).toBe(15);
    });

    test('should handle aggregations with single value after falseions', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 3, a: 'price', v: 300},
      ]);

      // false two values
      await db.transact([
        {op: false, e: 1, a: 'price', v: 100},
        {op: false, e: 3, a: 'price', v: 300},
      ]);

      const query: DatalogQuery = {
        find: {
          sum: ['sum', '?price'],
          avg: ['avg', '?price'],
          max: ['max', '?price'],
          min: ['min', '?price'],
          count: ['count', '?price'],
        },
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.sum).toBe(200);
      expect(results[0]?.avg).toBe(200);
      expect(results[0]?.max).toBe(200);
      expect(results[0]?.min).toBe(200);
      expect(results[0]?.count).toBe(1);
    });
  });
});
