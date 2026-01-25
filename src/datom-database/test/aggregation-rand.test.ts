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

  describe.todo('Aggregation: rand', () => {
    test('should return N random values with replacement', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {random: {t: 'rand', c: '?value', count: 3}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]?.random;
      expect(randomValues).toBeDefined();
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as number[]).length).toBe(3);
      // All values should be from the set
      for (const val of randomValues as unknown as number[]) {
        expect([10, 20, 30]).toContain(val);
      }
    });

    test('should return null for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {random: {t: 'rand', c: '?value', count: 1}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.random === null || results[0]?.random === undefined).toBe(true);
    });

    test('should return single value when N=1', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
        {op: true, e: 3, a: 'value', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {random: {t: 'rand', c: '?value', count: 1}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValue = results[0]?.random;
      expect(randomValue).toBeDefined();
      expect([10, 20, 30]).toContain(randomValue as number);
      expect(Array.isArray(randomValue)).toBe(false);
    });

    test('should allow duplicates (with replacement)', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 10},
        {op: true, e: 2, a: 'value', v: 20},
      ]);

      const query: DatalogQuery = {
        find: {random: {t: 'rand', c: '?value', count: 5}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]?.random;
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as number[]).length).toBe(5);
      // Should allow duplicates (with replacement)
      for (const val of randomValues as unknown as number[]) {
        expect([10, 20]).toContain(val);
      }
    });

    test('should work with string values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Charlie'},
      ]);

      const query: DatalogQuery = {
        find: {random: {t: 'rand', c: '?name', count: 2}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]?.random;
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as string[]).length).toBe(2);
      for (const val of randomValues as unknown as string[]) {
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
        find: {random: {t: 'rand', c: '?price', count: 3}},
        where: [
          {t: 'match', e: '?e', a: 'type', v: 'product'},
          {t: 'match', e: '?e', a: 'price', v: '?price'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      const randomValues = results[0]?.random;
      expect(Array.isArray(randomValues)).toBe(true);
      expect((randomValues as unknown as number[]).length).toBe(3);
      for (const val of randomValues as unknown as number[]) {
        expect([100, 200]).toContain(val);
      }
    });
  });
});
