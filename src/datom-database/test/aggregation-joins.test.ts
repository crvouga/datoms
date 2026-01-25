import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog-query.js';
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

  describe.todo('Aggregations with Joins', () => {
    test('should aggregate values across joined entities', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Product A'},
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'name', v: 'Product B'},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 3, a: 'name', v: 'Product C'},
        {op: true, e: 3, a: 'price', v: 300},
      ]);

      const query: DatalogQuery = {
        find: {
          total: {t: 'sum', c: '?price'},
          average: {t: 'avg', c: '?price'},
          count: {t: 'count', c: '?e'},
        },
        where: [
          {e: '?e', a: 'name', v: '?name'},
          {e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(600);
      expect(results[0]?.average).toBe(200);
      expect(results[0]?.count).toBe(3);
    });

    test('should aggregate with relationship joins', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Order 1'},
        {op: true, e: 1, a: 'customer', v: 10},
        {op: true, e: 2, a: 'name', v: 'Order 2'},
        {op: true, e: 2, a: 'customer', v: 10},
        {op: true, e: 3, a: 'name', v: 'Order 3'},
        {op: true, e: 3, a: 'customer', v: 20},
        {op: true, e: 10, a: 'name', v: 'Customer A'},
        {op: true, e: 20, a: 'name', v: 'Customer B'},
      ]);

      const query: DatalogQuery = {
        find: {
          orderCount: {t: 'count', c: '?order'},
          customerCount: {t: 'count-distinct', c: '?customer'},
        },
        where: [
          {e: '?order', a: 'customer', v: '?customer'},
          {e: '?customer', a: 'name', v: '?customerName'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.orderCount).toBe(3);
      expect(results[0]?.customerCount).toBe(2);
    });

    test('should aggregate with multiple join conditions', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'type', v: 'product'},
        {op: true, e: 1, a: 'category', v: 'electronics'},
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'type', v: 'product'},
        {op: true, e: 2, a: 'category', v: 'electronics'},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 3, a: 'type', v: 'product'},
        {op: true, e: 3, a: 'category', v: 'clothing'},
        {op: true, e: 3, a: 'price', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {
          total: {t: 'sum', c: '?price'},
          average: {t: 'avg', c: '?price'},
          maxPrice: {t: 'max', c: '?price', count: 1},
        },
        where: [
          {e: '?e', a: 'type', v: 'product'},
          {e: '?e', a: 'category', v: 'electronics'},
          {e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(300);
      expect(results[0]?.average).toBe(150);
      expect(results[0]?.maxPrice).toBe(200);
    });

    test('should aggregate with self-joins', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Parent'},
        {op: true, e: 1, a: 'value', v: 100},
        {op: true, e: 2, a: 'name', v: 'Child 1'},
        {op: true, e: 2, a: 'parent', v: 1},
        {op: true, e: 2, a: 'value', v: 50},
        {op: true, e: 3, a: 'name', v: 'Child 2'},
        {op: true, e: 3, a: 'parent', v: 1},
        {op: true, e: 3, a: 'value', v: 75},
      ]);

      const query: DatalogQuery = {
        find: {
          childCount: {t: 'count', c: '?child'},
          childTotal: {t: 'sum', c: '?childValue'},
          childAvg: {t: 'avg', c: '?childValue'},
        },
        where: [
          {e: '?parent', a: 'name', v: 'Parent'},
          {e: '?child', a: 'parent', v: '?parent'},
          {e: '?child', a: 'value', v: '?childValue'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.childCount).toBe(2);
      expect(results[0]?.childTotal).toBe(125);
      expect(results[0]?.childAvg).toBe(62.5);
    });

    test('should handle aggregations with empty joins', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Product A'},
        {op: true, e: 1, a: 'price', v: 100},
      ]);

      const query: DatalogQuery = {
        find: {
          total: {t: 'sum', c: '?price'},
          count: {t: 'count', c: '?e'},
        },
        where: [
          {e: '?e', a: 'name', v: '?name'},
          {e: '?e', a: 'price', v: '?price'},
          {e: '?e', a: 'category', v: 'electronics'}, // No matching category
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(0);
      expect(results[0]?.count).toBe(0);
    });
  });
});
