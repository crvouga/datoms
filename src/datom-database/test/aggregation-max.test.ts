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

  describe('Aggregation: max', () => {
    test('should find maximum numeric value', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'age', v: 25},
        {op: true, e: 2, a: 'age', v: 30},
        {op: true, e: 3, a: 'age', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(30);
    });

    test('should return null or undefined for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {maximum: ['max', '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum === null || results[0]?.maximum === undefined).toBe(true);
    });

    test('should find maximum of single value', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'price', v: 100}]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?price']},
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(100);
    });

    test('should find maximum with negative numbers', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: -10},
        {op: true, e: 2, a: 'value', v: -5},
        {op: true, e: 3, a: 'value', v: -20},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(-5);
    });

    test('should find maximum decimal numbers', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'price', v: 10.5},
        {op: true, e: 2, a: 'price', v: 5.25},
        {op: true, e: 3, a: 'price', v: 15.75},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?price']},
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(15.75);
    });

    test('should find maximum string values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Charlie'},
        {op: true, e: 3, a: 'name', v: 'Bob'},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?name']},
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe('Charlie');
    });

    test('should find maximum with filters', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'type', v: 'product'},
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'type', v: 'product'},
        {op: true, e: 2, a: 'price', v: 200},
        {op: true, e: 3, a: 'type', v: 'service'},
        {op: true, e: 3, a: 'price', v: 300},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?price']},
        where: [
          {e: '?e', a: 'type', v: 'product'},
          {e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(200);
    });

    test('should find maximum with duplicate values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 20},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 10},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(20);
    });

    test('should find maximum with zero values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 0},
        {op: true, e: 2, a: 'value', v: -10},
        {op: true, e: 3, a: 'value', v: 5},
      ]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(5);
    });

    test('should find maximum after updates', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'price', v: 100},
        {op: true, e: 2, a: 'price', v: 200},
      ]);

      // Update to a higher value
      await db.transact([{op: true, e: 1, a: 'price', v: 300}]);

      const query: DatalogQuery = {
        find: {maximum: ['max', '?price']},
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.maximum).toBe(300);
    });
  });
});
