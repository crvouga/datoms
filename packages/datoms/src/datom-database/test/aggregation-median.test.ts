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

  describe.todo('Aggregation: median', () => {
    test('should calculate median of odd number of values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'age', v: 20},
        {op: true, e: '2', a: 'age', v: 30},
        {op: true, e: '3', a: 'age', v: 40},
      ]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.median).toBe(30);
    });

    test('should calculate median of even number of values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'age', v: 20},
        {op: true, e: '2', a: 'age', v: 30},
        {op: true, e: '3', a: 'age', v: 40},
        {op: true, e: '4', a: 'age', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Median of [20, 30, 40, 50] is average of 30 and 40 = 35
      expect(results[0]?.median).toBe(35);
    });

    test('should return null or undefined for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.median === null || results[0]?.median === undefined).toBe(true);
    });

    test('should calculate median of single value', async () => {
      const {db} = f;
      await db.write([{op: true, e: '1', a: 'score', v: 85}]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?score'}},
        where: [{t: 'match', e: '?e', a: 'score', v: '?score'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.median).toBe(85);
    });

    test('should calculate median with unsorted values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 50},
        {op: true, e: '2', a: 'value', v: 10},
        {op: true, e: '3', a: 'value', v: 30},
        {op: true, e: '4', a: 'value', v: 20},
        {op: true, e: '5', a: 'value', v: 40},
      ]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Sorted: [10, 20, 30, 40, 50], median = 30
      expect(results[0]?.median).toBe(30);
    });

    test('should calculate median with duplicate values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 10},
        {op: true, e: '2', a: 'value', v: 20},
        {op: true, e: '3', a: 'value', v: 20},
        {op: true, e: '4', a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Sorted: [10, 20, 20, 30], median = average of 20 and 20 = 20
      expect(results[0]?.median).toBe(20);
    });

    test('should calculate median with filters', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'type', v: 'student'},
        {op: true, e: '1', a: 'score', v: 80},
        {op: true, e: '2', a: 'type', v: 'student'},
        {op: true, e: '2', a: 'score', v: 90},
        {op: true, e: '3', a: 'type', v: 'student'},
        {op: true, e: '3', a: 'score', v: 100},
        {op: true, e: '4', a: 'type', v: 'teacher'},
        {op: true, e: '4', a: 'score', v: 95},
      ]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?score'}},
        where: [
          {t: 'match', e: '?e', a: 'type', v: 'student'},
          {t: 'match', e: '?e', a: 'score', v: '?score'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Sorted: [80, 90, 100], median = 90
      expect(results[0]?.median).toBe(90);
    });

    test('should calculate median with decimal numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'price', v: 10.5},
        {op: true, e: '2', a: 'price', v: 20.5},
        {op: true, e: '3', a: 'price', v: 30.5},
        {op: true, e: '4', a: 'price', v: 40.5},
      ]);

      const query: DatalogQuery = {
        find: {median: {t: 'median', c: '?price'}},
        where: [{t: 'match', e: '?e', a: 'price', v: '?price'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Median of [10.5, 20.5, 30.5, 40.5] = average of 20.5 and 30.5 = 25.5
      expect(results[0]?.median).toBeCloseTo(25.5, 2);
    });
  });
});
