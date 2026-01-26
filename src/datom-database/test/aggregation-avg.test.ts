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

  describe.todo('Aggregation: avg', () => {
    test('should calculate average of numeric values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'age', v: 20},
        {op: true, e: '2', a: 'age', v: 30},
        {op: true, e: '3', a: 'age', v: 40},
      ]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBe(30);
    });

    test('should return null or 0 for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Average of empty set could be null, undefined, or 0 depending on implementation
      expect(
        results[0]?.average === null ||
          results[0]?.average === undefined ||
          results[0]?.average === 0,
      ).toBe(true);
    });

    test('should calculate average of single value', async () => {
      const {db} = f;
      await db.write([{op: true, e: '1', a: 'score', v: 85}]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?score'}},
        where: [{t: 'match', e: '?e', a: 'score', v: '?score'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBe(85);
    });

    test('should calculate average of decimal numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'price', v: 10.5},
        {op: true, e: '2', a: 'price', v: 20.5},
        {op: true, e: '3', a: 'price', v: 30.0},
      ]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?price'}},
        where: [{t: 'match', e: '?e', a: 'price', v: '?price'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBeCloseTo(20.333, 2);
    });

    test('should calculate average with negative numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 10},
        {op: true, e: '2', a: 'value', v: -5},
        {op: true, e: '3', a: 'value', v: 15},
      ]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBeCloseTo(6.667, 2);
    });

    test('should calculate average with filters', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'type', v: 'student'},
        {op: true, e: '1', a: 'score', v: 80},
        {op: true, e: '2', a: 'type', v: 'student'},
        {op: true, e: '2', a: 'score', v: 90},
        {op: true, e: '3', a: 'type', v: 'teacher'},
        {op: true, e: '3', a: 'score', v: 95},
      ]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?score'}},
        where: [
          {t: 'match', e: '?e', a: 'type', v: 'student'},
          {t: 'match', e: '?e', a: 'score', v: '?score'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBe(85);
    });

    test('should calculate average with duplicate values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 10},
        {op: true, e: '2', a: 'value', v: 10},
        {op: true, e: '3', a: 'value', v: 10},
      ]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBe(10);
    });

    test('should calculate average with zero values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 0},
        {op: true, e: '2', a: 'value', v: 0},
        {op: true, e: '3', a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.average).toBe(10);
    });

    test('should calculate average after updates', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'score', v: 50},
        {op: true, e: '2', a: 'score', v: 60},
        {op: true, e: '3', a: 'score', v: 70},
      ]);

      // Update a value (true adds a new value, doesn't replace)
      await db.write([{op: true, e: '1', a: 'score', v: 80}]);

      const query: DatalogQuery = {
        find: {average: {t: 'avg', c: '?score'}},
        where: [{t: 'match', e: '?e', a: 'score', v: '?score'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      // Average of [50, 60, 70, 80] = 65
      expect(results[0]?.average).toBeCloseTo(65, 1);
    });
  });
});
