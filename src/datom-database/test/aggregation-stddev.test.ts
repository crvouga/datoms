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

  describe.todo('Aggregation: stddev', () => {
    test('should calculate standard deviation of numeric values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 20, variance = 66.67, stddev = sqrt(66.67) ≈ 8.16
      expect(results[0]?.stddev).toBeCloseTo(8.16, 1);
    });

    test('should return null or undefined for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.stddev === null || results[0]?.stddev === undefined).toBe(true);
    });

    test('should return 0 or null for single value', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'value', v: 10}]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Standard deviation of single value should be 0 or null/undefined
      expect(
        results[0]?.stddev === 0 || results[0]?.stddev === null || results[0]?.stddev === undefined,
      ).toBe(true);
    });

    test('should calculate standard deviation with identical values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 10},
        {op: true, e: 3, a: 'value', v: 10},
      ]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Standard deviation of identical values should be 0
      expect(results[0]?.stddev).toBe(0);
    });

    test('should calculate standard deviation with negative numbers', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: -10},
        {op: true, e: 2, a: 'value', v: 0},
        {op: true, e: 3, a: 'value', v: 10},
      ]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 0, variance = 66.67, stddev = sqrt(66.67) ≈ 8.16
      expect(results[0]?.stddev).toBeCloseTo(8.16, 1);
    });

    test('should calculate standard deviation with decimal numbers', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10.5},
        {op: true, e: 2, a: 'value', v: 20.5},
        {op: true, e: 3, a: 'value', v: 30.5},
      ]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 20.5, variance = 66.67, stddev = sqrt(66.67) ≈ 8.16
      expect(results[0]?.stddev).toBeCloseTo(8.16, 1);
    });

    test('should calculate standard deviation with filters', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'type', v: 'group1'},
        {op: true, e: 1, a: 'score', v: 80},
        {op: true, e: 2, a: 'type', v: 'group1'},
        {op: true, e: 2, a: 'score', v: 90},
        {op: true, e: 3, a: 'type', v: 'group1'},
        {op: true, e: 3, a: 'score', v: 100},
        {op: true, e: 4, a: 'type', v: 'group2'},
        {op: true, e: 4, a: 'score', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?score'}},
        where: [
          {t: 'match', e: '?e', a: 'type', v: 'group1'},
          {t: 'match', e: '?e', a: 'score', v: '?score'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 90, variance = 66.67, stddev = sqrt(66.67) ≈ 8.16
      expect(results[0]?.stddev).toBeCloseTo(8.16, 1);
    });

    test('should calculate standard deviation with larger dataset', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 1},
        {op: true, e: 2, a: 'value', v: 2},
        {op: true, e: 3, a: 'value', v: 3},
        {op: true, e: 4, a: 'value', v: 4},
        {op: true, e: 5, a: 'value', v: 5},
      ]);

      const query: DatalogQuery = {
        find: {stddev: {t: 'stddev', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      // Mean = 3, variance = 2, stddev = sqrt(2) ≈ 1.41
      expect(results[0]?.stddev).toBeCloseTo(1.41, 1);
    });
  });
});
