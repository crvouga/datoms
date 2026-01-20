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

  describe('Aggregation: median', () => {
    test('should calculate median of odd number of values', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'age', v: 20},
        {op: 'assert', e: 2, a: 'age', v: 30},
        {op: 'assert', e: 3, a: 'age', v: 40},
      ]);

      const query: DatalogQuery = {
        find: {median: ['median', '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['median']).toBe(30);
    });

    test('should calculate median of even number of values', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'age', v: 20},
        {op: 'assert', e: 2, a: 'age', v: 30},
        {op: 'assert', e: 3, a: 'age', v: 40},
        {op: 'assert', e: 4, a: 'age', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {median: ['median', '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Median of [20, 30, 40, 50] is average of 30 and 40 = 35
      expect(results[0]!['median']).toBe(35);
    });

    test('should return null or undefined for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {median: ['median', '?age']},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['median'] === null || results[0]!['median'] === undefined).toBe(true);
    });

    test('should calculate median of single value', async () => {
      const {db} = f;
      await db.transact([{op: 'assert', e: 1, a: 'score', v: 85}]);

      const query: DatalogQuery = {
        find: {median: ['median', '?score']},
        where: [{e: '?e', a: 'score', v: '?score'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]!['median']).toBe(85);
    });

    test('should calculate median with unsorted values', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'value', v: 50},
        {op: 'assert', e: 2, a: 'value', v: 10},
        {op: 'assert', e: 3, a: 'value', v: 30},
        {op: 'assert', e: 4, a: 'value', v: 20},
        {op: 'assert', e: 5, a: 'value', v: 40},
      ]);

      const query: DatalogQuery = {
        find: {median: ['median', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Sorted: [10, 20, 30, 40, 50], median = 30
      expect(results[0]!['median']).toBe(30);
    });

    test('should calculate median with duplicate values', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'value', v: 10},
        {op: 'assert', e: 2, a: 'value', v: 20},
        {op: 'assert', e: 3, a: 'value', v: 20},
        {op: 'assert', e: 4, a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {median: ['median', '?value']},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Sorted: [10, 20, 20, 30], median = average of 20 and 20 = 20
      expect(results[0]!['median']).toBe(20);
    });

    test('should calculate median with filters', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'type', v: 'student'},
        {op: 'assert', e: 1, a: 'score', v: 80},
        {op: 'assert', e: 2, a: 'type', v: 'student'},
        {op: 'assert', e: 2, a: 'score', v: 90},
        {op: 'assert', e: 3, a: 'type', v: 'student'},
        {op: 'assert', e: 3, a: 'score', v: 100},
        {op: 'assert', e: 4, a: 'type', v: 'teacher'},
        {op: 'assert', e: 4, a: 'score', v: 95},
      ]);

      const query: DatalogQuery = {
        find: {median: ['median', '?score']},
        where: [
          {e: '?e', a: 'type', v: 'student'},
          {e: '?e', a: 'score', v: '?score'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Sorted: [80, 90, 100], median = 90
      expect(results[0]!['median']).toBe(90);
    });

    test('should calculate median with decimal numbers', async () => {
      const {db} = f;
      await db.transact([
        {op: 'assert', e: 1, a: 'price', v: 10.5},
        {op: 'assert', e: 2, a: 'price', v: 20.5},
        {op: 'assert', e: 3, a: 'price', v: 30.5},
        {op: 'assert', e: 4, a: 'price', v: 40.5},
      ]);

      const query: DatalogQuery = {
        find: {median: ['median', '?price']},
        where: [{e: '?e', a: 'price', v: '?price'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Median of [10.5, 20.5, 30.5, 40.5] = average of 20.5 and 30.5 = 25.5
      expect(results[0]!['median']).toBeCloseTo(25.5, 2);
    });
  });
});
