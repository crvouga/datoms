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

  describe.todo('Aggregation: sum', () => {
    test('should sum numeric values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'age', v: 25},
        {op: true, e: '2', a: 'age', v: 30},
        {op: true, e: '3', a: 'age', v: 35},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(90);
    });

    test('should return 0 for empty results', async () => {
      const {db} = f;
      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?age'}},
        where: [{t: 'match', e: '?e', a: 'age', v: '?age'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(0);
    });

    test('should sum single value', async () => {
      const {db} = f;
      await db.write([{op: true, e: '1', a: 'price', v: 100}]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?price'}},
        where: [{t: 'match', e: '?e', a: 'price', v: '?price'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(100);
    });

    test('should sum negative numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 10},
        {op: true, e: '2', a: 'value', v: -5},
        {op: true, e: '3', a: 'value', v: 3},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(8);
    });

    test('should sum decimal numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'price', v: 10.5},
        {op: true, e: '2', a: 'price', v: 20.25},
        {op: true, e: '3', a: 'price', v: 5.75},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?price'}},
        where: [{t: 'match', e: '?e', a: 'price', v: '?price'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBeCloseTo(36.5, 2);
    });

    test('should sum with filters', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'type', v: 'product'},
        {op: true, e: '1', a: 'price', v: 100},
        {op: true, e: '2', a: 'type', v: 'product'},
        {op: true, e: '2', a: 'price', v: 200},
        {op: true, e: '3', a: 'type', v: 'service'},
        {op: true, e: '3', a: 'price', v: 50},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?price'}},
        where: [
          {t: 'match', e: '?e', a: 'type', v: 'product'},
          {t: 'match', e: '?e', a: 'price', v: '?price'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(300);
    });

    test('should sum large numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 1000000},
        {op: true, e: '2', a: 'value', v: 2000000},
        {op: true, e: '3', a: 'value', v: 3000000},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(6000000);
    });

    test('should sum zero values', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 0},
        {op: true, e: '2', a: 'value', v: 0},
        {op: true, e: '3', a: 'value', v: 10},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(10);
    });

    test('should sum values after retraction', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'price', v: 100},
        {op: true, e: '2', a: 'price', v: 200},
        {op: true, e: '3', a: 'price', v: 300},
      ]);

      // false one value
      await db.write([{op: false, e: '2', a: 'price', v: 200}]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?price'}},
        where: [{t: 'match', e: '?e', a: 'price', v: '?price'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBe(400);
    });

    test('should sum with very small decimal numbers', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: '1', a: 'value', v: 0.0001},
        {op: true, e: '2', a: 'value', v: 0.0002},
        {op: true, e: '3', a: 'value', v: 0.0003},
      ]);

      const query: DatalogQuery = {
        find: {total: {t: 'sum', c: '?value'}},
        where: [{t: 'match', e: '?e', a: 'value', v: '?value'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.total).toBeCloseTo(0.0006, 4);
    });
  });
});
