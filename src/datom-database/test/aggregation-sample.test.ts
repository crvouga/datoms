import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog.js';
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

  describe.todo('Aggregation: sample', () => {
    test('should return a sample of N values from the set', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {sample: {t: 'sample', c: '?value', count: 2}},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]?.sample;
      expect(sampleValues).toBeDefined();
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(2);
      // All values should be from the set
      for (const val of sampleValues as unknown as number[]) {
        expect([10, 20, 30]).toContain(val);
      }
      // Should have no duplicates (sample is without replacement)
      const unique = new Set(sampleValues as unknown as number[]);
      expect(unique.size).toBe(2);
    });

    test('should return null for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {sample: {t: 'sample', c: '?value', count: 1}},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.sample === null || results[0]?.sample === undefined).toBe(true);
    });

    test('should return single value when N=1', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {sample: {t: 'sample', c: '?value', count: 1}},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValue = results[0]?.sample;
      expect(sampleValue).toBeDefined();
      expect([10, 20, 30]).toContain(sampleValue as number);
      expect(Array.isArray(sampleValue)).toBe(false);
    });

    test('should return all values when N >= total', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {sample: {t: 'sample', c: '?value', count: 5}},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]?.sample;
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(2);
      expect((sampleValues as unknown as number[]).sort()).toEqual([10, 20]);
    });

    test('should return array of N values without duplicates', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
        {op: true, e: 4, a: 'value', v: 40},
        {op: true, e: 5, a: 'value', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {sample: {t: 'sample', c: '?value', count: 3}},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]?.sample;
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(3);
      // Check no duplicates
      const unique = new Set(sampleValues as unknown as number[]);
      expect(unique.size).toBe(3);
    });

    test('should work with string values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Charlie'},
      ]);

      const query: DatalogQuery = {
        find: {sample: {t: 'sample', c: '?name', count: 2}},
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]?.sample;
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as string[]).length).toBe(2);
      for (const val of sampleValues as unknown as string[]) {
        expect(['Alice', 'Bob', 'Charlie']).toContain(val);
      }
    });

    test('should work with filters', async () => {
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
        find: {sample: {t: 'sample', c: '?price', count: 2}},
        where: [
          {e: '?e', a: 'type', v: 'product'},
          {e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const sampleValues = results[0]?.sample;
      expect(Array.isArray(sampleValues)).toBe(true);
      expect((sampleValues as unknown as number[]).length).toBe(2);
      expect((sampleValues as unknown as number[]).sort()).toEqual([100, 200]);
    });
  });
});
