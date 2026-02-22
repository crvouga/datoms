import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog-query.js';
import type {Fixture} from './fixtures/fixture.js';
import {FIXTURES} from './fixtures/fixtures.js';

describe.each(FIXTURES)('DatomDatabase (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe.todo('Aggregation: count', () => {
    test('should count all matching values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'age', v: 25},
        {op: true, e: '2', a: 'age', v: 30},
        {op: true, e: '3', a: 'age', v: 35},
      ]);

      const found = await db.read({
        find: {total: {t: 'count', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(3);
    });

    test('should return 0 for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(0);
    });

    test('should count single value', async () => {
      const {db} = f;
      await db.write([{op: true, e: '1', a: 'name', v: 'Alice'}]);

      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?name'}},
        where: [{t: 'match', e: '?e', a: 'name', v: '?name'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(1);
    });

    test('should count with filters', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'type', v: 'person'},
        {op: true, e: '2', a: 'type', v: 'person'},
        {op: true, e: '3', a: 'type', v: 'car'},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?e'}},
        where: [{t: 'match', e: '?e', a: 'type', v: 'person'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(2);
    });

    test('should count with multiple clauses', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'name', v: 'Alice'},
        {op: true, e: '1', a: 'age', v: 25},
        {op: true, e: '2', a: 'name', v: 'Bob'},
        {op: true, e: '2', a: 'age', v: 30},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?e'}},
        where: [
          {t: 'match', e: '?e', a: 'name', v: '?name'},
          {t: 'match', e: '?e', a: 'age', v: '?age'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(2);
    });

    test('should count different data types', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 42},
        {op: true, e: '2', a: 'value', v: 'test'},
        {op: true, e: '3', a: 'value', v: true},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(3);
    });

    test('should count after retractions', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'item', v: 'A'},
        {op: true, e: '2', a: 'item', v: 'B'},
        {op: true, e: '3', a: 'item', v: 'C'},
        {op: true, e: '4', a: 'item', v: 'D'},
      ]);

      // false two items
      await db.write([
        {op: false, e: '2', a: 'item', v: 'B'},
        {op: false, e: '4', a: 'item', v: 'D'},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?item'}},
        where: [{t: 'match', e: '?e', a: 'item', v: '?item'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(2);
    });

    test('should count with complex joins', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'order', v: 100},
        {op: true, e: '1', a: 'product', v: 1},
        {op: true, e: '2', a: 'order', v: 100},
        {op: true, e: '2', a: 'product', v: 2},
        {op: true, e: '3', a: 'order', v: 200},
        {op: true, e: '3', a: 'product', v: 1},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'count', c: '?line'}},
        where: [
          {t: 'match', e: '?line', a: 'order', v: '?order'},
          {t: 'match', e: '?line', a: 'product', v: '?product'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(3);
    });
  });
});
