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

  describe.todo('Aggregation: count-distinct', () => {
    test('should count distinct values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Alice'},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count-distinct', c: '?name'}},
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(2);
    });

    test('should return 0 for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {total: {t: 'count-distinct', c: '?name'}},
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(0);
    });

    test('should count distinct single value', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const query: DatalogQuery = {
        find: {total: {t: 'count-distinct', c: '?name'}},
        where: [{e: '?e', a: 'name', v: '?name'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(1);
    });

    test('should count distinct numeric values', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'age', v: 25},
        {op: true, e: 2, a: 'age', v: 30},
        {op: true, e: 3, a: 'age', v: 25},
        {op: true, e: 4, a: 'age', v: 30},
        {op: true, e: 5, a: 'age', v: 35},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count-distinct', c: '?age'}},
        where: [{e: '?e', a: 'age', v: '?age'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(3);
    });

    test('should count distinct with filters', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'type', v: 'person'},
        {op: true, e: 1, a: 'city', v: 'NYC'},
        {op: true, e: 2, a: 'type', v: 'person'},
        {op: true, e: 2, a: 'city', v: 'LA'},
        {op: true, e: 3, a: 'type', v: 'person'},
        {op: true, e: 3, a: 'city', v: 'NYC'},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count-distinct', c: '?city'}},
        where: [
          {e: '?e', a: 'type', v: 'person'},
          {e: '?e', a: 'city', v: '?city'},
        ],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(2);
    });

    test('should count distinct different data types', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'value', v: 42},
        {op: true, e: 2, a: 'value', v: 'test'},
        {op: true, e: 3, a: 'value', v: 42},
        {op: true, e: 4, a: 'value', v: true},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count-distinct', c: '?value'}},
        where: [{e: '?e', a: 'value', v: '?value'}],
      };

      const {data: results} = await db.query(query);
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(3);
    });
  });
});
