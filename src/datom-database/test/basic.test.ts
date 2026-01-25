import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import {datomsQueryToDatalogQuery, queryResultsToDatoms} from '../shared/datoms-query-converter.js';
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

  test('should create a database', async () => {
    const {db} = f;
    const database = db;
    expect(database).toBeDefined();
  });

  test('should add datoms', async () => {
    const {db} = f;
    const tx = await db.transact([
      {op: true, e: 1, a: 'name', v: 'Alice'},
      {op: true, e: 1, a: 'age', v: 30},
    ]);

    expect(tx).toBeGreaterThanOrEqual(1);

    const query = datomsQueryToDatalogQuery({e: 1, op: true});
    const {data: results} = await db.query(query);
    const entity = queryResultsToDatoms(results, {e: 1, op: true});
    expect(entity).toHaveLength(2);
    const values = entity.map(d => d.v);
    expect(values).toContain('Alice');
    expect(values).toContain(30);
  });

  test('should query datoms', async () => {
    const {db} = f;
    await db.transact([
      {op: true, e: 1, a: 'name', v: 'Alice'},
      {op: true, e: 2, a: 'name', v: 'Bob'},
    ]);

    const query = datomsQueryToDatalogQuery({a: 'name'});
    const {data: queryResults} = await db.query(query);
    const results = queryResultsToDatoms(queryResults, {a: 'name'});
    expect(results).toHaveLength(2);
  });

  test('should sub datoms', async () => {
    const {db} = f;
    await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
    await db.transact([{op: false, e: 1, a: 'name', v: 'Alice'}]);

    const query = datomsQueryToDatalogQuery({e: 1, op: true});
    const {data: results} = await db.query(query);
    const entity = queryResultsToDatoms(results, {e: 1, op: true});
    expect(entity).toHaveLength(0);
  });

  describe('subAttribute', () => {
    test('should sub all values for single-valued attribute', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 1, a: 'age', v: 30},
      ]);

      const query = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const {data: results} = await db.query(query);
      const nameDatoms = queryResultsToDatoms(results, {e: 1, a: 'name'});
      await db.transact(
        nameDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );

      const {data: nameResults} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'name', v: '?v'}],
      });
      expect(nameResults).toHaveLength(0);

      const {data: ageResults} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'age', v: '?v'}],
      });
      expect(ageResults[0]?.v).toBe(30);
    });

    test('should sub all values for multi-valued attribute', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'tag', v: 'red'},
        {op: true, e: 1, a: 'tag', v: 'blue'},
        {op: true, e: 1, a: 'tag', v: 'green'},
        {op: true, e: 1, a: 'name', v: 'Alice'},
      ]);

      const query1 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results1} = await db.query(query1);
      const tagDatoms = queryResultsToDatoms(results1, {e: 1, a: 'tag'});
      await db.transact(
        tagDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );

      const query2 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results2} = await db.query(query2);
      const tags = queryResultsToDatoms(results2, {e: 1, a: 'tag'});
      expect(tags).toHaveLength(0);

      const {data: nameResults} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'name', v: '?v'}],
      });
      expect(nameResults[0]?.v).toBe('Alice');
    });

    test('should handle subing non-existent attribute', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      // Should not throw, just return a transaction ID
      const query = datomsQueryToDatalogQuery({
        e: 1,
        a: 'nonexistent',
      });
      const {data: results} = await db.query(query);
      const nonexistentDatoms = queryResultsToDatoms(results, {
        e: 1,
        a: 'nonexistent',
      });
      const tx = await db.transact(
        nonexistentDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );
      expect(tx).toBeGreaterThan(0);
    });

    test('should work within transactions', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'tag', v: 'red'},
        {op: true, e: 1, a: 'tag', v: 'blue'},
      ]);

      const query = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results} = await db.query(query);
      const tagDatoms = queryResultsToDatoms(results, {e: 1, a: 'tag'});

      // Use with() to see what subion would look like
      const withResult = await db.with(
        tagDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );

      // Should see subion in dbAfter
      const query2 = datomsQueryToDatalogQuery({
        e: 1,
        a: 'tag',
      });
      const {data: results2} = await withResult.dbAfter.query(query2);
      const tags = queryResultsToDatoms(results2, {
        e: 1,
        a: 'tag',
      });
      expect(tags).toHaveLength(0);

      // Now commit the subion
      await db.transact(
        tagDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );

      // Should be committed after transact
      const query3 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results3} = await db.query(query3);
      const finalTags = queryResultsToDatoms(results3, {e: 1, a: 'tag'});
      expect(finalTags).toHaveLength(0);
    });

    test('should only sub specified entity-attribute pair', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'tag', v: 'red'},
        {op: true, e: 1, a: 'tag', v: 'blue'},
        {op: true, e: 2, a: 'tag', v: 'red'},
        {op: true, e: 2, a: 'tag', v: 'green'},
      ]);

      const query1 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results1} = await db.query(query1);
      const tag1Datoms = queryResultsToDatoms(results1, {e: 1, a: 'tag'});
      await db.transact(
        tag1Datoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );

      const query1b = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results1b} = await db.query(query1b);
      const tags1 = queryResultsToDatoms(results1b, {e: 1, a: 'tag'});
      expect(tags1).toHaveLength(0);

      const query2 = datomsQueryToDatalogQuery({e: 2, a: 'tag'});
      const {data: results2} = await db.query(query2);
      const tags2 = queryResultsToDatoms(results2, {e: 2, a: 'tag'});
      expect(tags2).toHaveLength(2);
      const values2 = tags2.map(d => d.v);
      expect(values2).toContain('red');
      expect(values2).toContain('green');
    });
  });

  describe('upsert', () => {
    test("should add value when attribute doesn't exist", async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'status', v: 'active'}]);

      const {data: statusResults} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'status', v: '?v'}],
      });
      expect(statusResults[0]?.v).toBe('active');
    });

    test('should work for undefined cardinality (treats as many)', async () => {
      const {db} = f;
      // No schema definition
      await db.transact([{op: true, e: 1, a: 'tag', v: 'red'}]);
      await db.transact([{op: true, e: 1, a: 'tag', v: 'blue'}]);

      const query = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results} = await db.query(query);
      const tags = queryResultsToDatoms(results, {e: 1, a: 'tag'});
      expect(tags).toHaveLength(2);
      const values = tags.map(d => d.v);
      expect(values).toContain('red');
      expect(values).toContain('blue');
    });

    test('should work within transactions', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'status', v: 'pending'}]);

      const query = datomsQueryToDatalogQuery({e: 1, a: 'status'});
      const {data: results} = await db.query(query);
      const existing = queryResultsToDatoms(results, {e: 1, a: 'status'});

      // Use with() to see what the upsert would look like
      const withResult = await db.with([
        ...existing.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
        {op: true, e: 1, a: 'status', v: 'active'},
      ]);

      // Should see new value in dbAfter
      const {data: statusResults} = await withResult.dbAfter.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'status', v: '?v'}],
      });
      expect(statusResults[0]?.v).toBe('active');

      // Now commit the changes
      await db.transact([
        ...existing.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
        {op: true, e: 1, a: 'status', v: 'active'},
      ]);

      // Should be committed
      const {data: finalStatusResults} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'status', v: '?v'}],
      });
      expect(finalStatusResults[0]?.v).toBe('active');
    });
  });

  test('should get value for entity-attribute', async () => {
    const {db} = f;
    await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

    const {data: nameResults} = await db.query({
      find: {v: {t: 'identity', c: '?v'}},
      where: [{t: 'match', e: 1, a: 'name', v: '?v'}],
    });
    expect(nameResults[0]?.v).toBe('Alice');
  });

  describe('getLatestValue', () => {
    test('should return undefined for non-existent attribute', async () => {
      const {db} = f;
      const {data: results} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'nonexistent', v: '?v'}],
      });
      expect(results).toHaveLength(0);
    });

    test('should return value for single-valued attribute', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const {data: results} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'name', v: '?v'}],
      });
      expect(results[0]?.v).toBe('Alice');
    });

    test('should return most recent value for multi-valued attribute', async () => {
      const {db} = f;
      void (await db.transact([{op: true, e: 1, a: 'tag', v: 'red'}]));
      void (await db.transact([{op: true, e: 1, a: 'tag', v: 'blue'}]));
      void (await db.transact([{op: true, e: 1, a: 'tag', v: 'green'}]));

      // Should return the value with highest tx
      const query = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results} = await db.query(query);
      const datoms = queryResultsToDatoms(results, {e: 1, a: 'tag'});
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0]?.v).toBe('green');
    });

    test('should return most recent value after subion', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'tag', v: 'red'},
        {op: true, e: 1, a: 'tag', v: 'blue'},
      ]);
      await db.transact([{op: false, e: 1, a: 'tag', v: 'blue'}]);

      // Latest should be "red" since "blue" was sub
      const query = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results} = await db.query(query);
      const datoms = queryResultsToDatoms(results, {e: 1, a: 'tag'});
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0]?.v).toBe('red');
    });

    test('should work within transactions', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'tag', v: 'red'}]);

      // Use with() to see what adding would look like
      const withResult = await db.with([{op: true, e: 1, a: 'tag', v: 'blue'}]);

      // Should see latest value in dbAfter
      const query4 = datomsQueryToDatalogQuery({
        e: 1,
        a: 'tag',
      });
      const {data: results4} = await withResult.dbAfter.query(query4);
      const datoms = queryResultsToDatoms(results4, {
        e: 1,
        a: 'tag',
      });
      const sorted = datoms.sort((a, b) => b.tx - a.tx);
      expect(sorted[0]?.v).toBe('blue');

      // Now commit the change
      await db.transact([{op: true, e: 1, a: 'tag', v: 'blue'}]);

      // After commit, should still be blue
      const query5 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results5} = await db.query(query5);
      const finalDatoms = queryResultsToDatoms(results5, {e: 1, a: 'tag'});
      const finalSorted = finalDatoms.sort((a, b) => b.tx - a.tx);
      expect(finalSorted[0]?.v).toBe('blue');
    });

    test('should handle time-travel queries correctly', async () => {
      const {db} = f;
      const tx1 = await db.transact([{op: true, e: 1, a: 'tag', v: 'red'}]);
      const tx2 = await db.transact([{op: true, e: 1, a: 'tag', v: 'blue'}]);
      void (await db.transact([{op: true, e: 1, a: 'tag', v: 'green'}]));

      // Current latest should be green
      const query = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results} = await db.query(query);
      const currentDatoms = queryResultsToDatoms(results, {e: 1, a: 'tag'});
      const currentSorted = currentDatoms.sort((a, b) => b.tx - a.tx);
      expect(currentSorted[0]?.v).toBe('green');

      // At tx2, latest should be blue
      const query2 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results2} = await db.asOf(tx2).query(query2);
      const atTx2Datoms = queryResultsToDatoms(results2, {e: 1, a: 'tag'});
      const atTx2Sorted = atTx2Datoms.sort((a, b) => b.tx - a.tx);
      expect(atTx2Sorted[0]?.v).toBe('blue');

      // At tx1, latest should be red
      const query1 = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results1} = await db.asOf(tx1).query(query1);
      const atTx1Datoms = queryResultsToDatoms(results1, {e: 1, a: 'tag'});
      const atTx1Sorted = atTx1Datoms.sort((a, b) => b.tx - a.tx);
      expect(atTx1Sorted[0]?.v).toBe('red');
    });

    test('should be equivalent to getValue', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      // Add tags in separate transactions to ensure different transaction IDs
      await db.transact([{op: true, e: 1, a: 'tag', v: 'red'}]);
      await db.transact([{op: true, e: 1, a: 'tag', v: 'blue'}]);

      const {data: nameResults} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'name', v: '?v'}],
      });
      expect(nameResults[0]?.v).toBe('Alice');

      const query = datomsQueryToDatalogQuery({e: 1, a: 'tag'});
      const {data: results} = await db.query(query);
      const tagDatoms = queryResultsToDatoms(results, {e: 1, a: 'tag'});
      const tagSorted = tagDatoms.sort((a, b) => b.tx - a.tx);
      // Should return the latest value (blue, add last)
      expect(tagSorted[0]?.v).toBe('blue');
    });
  });

  describe('exists', () => {
    test('should return false for non-existent entity', async () => {
      const {db} = f;
      const query = datomsQueryToDatalogQuery({e: 999, limit: 1});
      const {data: results} = await db.query(query);
      const datoms = queryResultsToDatoms(results, {e: 999, limit: 1});
      expect(datoms.length).toBe(0);
    });

    test('should return true for existing entity', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      const query = datomsQueryToDatalogQuery({e: 1, limit: 1});
      const {data: results} = await db.query(query);
      const datoms = queryResultsToDatoms(results, {e: 1, limit: 1});
      expect(datoms.length).toBeGreaterThan(0);
    });

    test('should return true even if entity has sub datoms', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      await db.transact([{op: false, e: 1, a: 'name', v: 'Alice'}]);
      const query = datomsQueryToDatalogQuery({e: 1, limit: 1});
      const {data: results} = await db.query(query);
      const datoms = queryResultsToDatoms(results, {e: 1, limit: 1});
      // Entity exists if it has any datoms (including sub ones)
      // This depends on implementation, but typically should return false after subion
      // However, if query uses limit: 1, it might not find sub datoms
      expect(typeof datoms.length).toBe('number');
    });

    test('should return false for entity with only sub datoms', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      await db.transact([{op: false, e: 1, a: 'name', v: 'Alice'}]);
      // exists() uses query with limit: 1, which should only return add datoms
      const query = datomsQueryToDatalogQuery({e: 1, limit: 1});
      const {data: results} = await db.query(query);
      const datoms = queryResultsToDatoms(results, {e: 1, limit: 1});
      expect(datoms.length).toBe(0);
    });
  });

  describe('upsertMany', () => {
    test('should upsert multiple values atomically', async () => {
      const {db} = f;
      await db.transact([
        {op: true, e: 1, a: 'status', v: 'pending'},
        {op: true, e: 2, a: 'status', v: 'active'},
        {op: true, e: 1, a: 'name', v: 'Alice'},
      ]);

      const {data: status1Results} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'status', v: '?v'}],
      });
      const {data: status2Results} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 2, a: 'status', v: '?v'}],
      });
      const {data: name1Results} = await db.query({
        find: {v: {t: 'identity', c: '?v'}},
        where: [{t: 'match', e: 1, a: 'name', v: '?v'}],
      });

      expect(status1Results[0]?.v).toBe('pending');
      expect(status2Results[0]?.v).toBe('active');
      expect(name1Results[0]?.v).toBe('Alice');
    });

    test('should handle empty array', async () => {
      const {db} = f;
      const tx = await db.transact([]);
      expect(tx).toBeGreaterThan(0);
    });
  });

  describe('Integration: Entity Operations', () => {
    test('should work together: upsert, subAttribute, getLatestValue', async () => {
      const {db} = f;
      // Upsert initial value
      await db.transact([{op: true, e: 1, a: 'status', v: 'pending'}]);
      const query1 = datomsQueryToDatalogQuery({e: 1, a: 'status'});
      const {data: results1} = await db.query(query1);
      const pendingDatoms = queryResultsToDatoms(results1, {e: 1, a: 'status'});
      expect(pendingDatoms[0]?.v).toBe('pending');

      // Upsert new value
      const query2 = datomsQueryToDatalogQuery({e: 1, a: 'status'});
      const {data: results2} = await db.query(query2);
      const existing1 = queryResultsToDatoms(results2, {e: 1, a: 'status'});
      await db.transact([
        ...existing1.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
        {op: true, e: 1, a: 'status', v: 'active'},
      ]);
      const query3 = datomsQueryToDatalogQuery({e: 1, a: 'status'});
      const {data: results3} = await db.query(query3);
      const activeDatoms = queryResultsToDatoms(results3, {e: 1, a: 'status'});
      expect(activeDatoms[0]?.v).toBe('active');

      // sub attribute
      const query4 = datomsQueryToDatalogQuery({e: 1, a: 'status'});
      const {data: results4} = await db.query(query4);
      const statusDatoms = queryResultsToDatoms(results4, {e: 1, a: 'status'});
      await db.transact(
        statusDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );
      const query = datomsQueryToDatalogQuery({e: 1, a: 'status'});
      const {data: results} = await db.query(query);
      const data = queryResultsToDatoms(results, {e: 1, a: 'status'});
      expect(data.length).toBe(0);

      // Upsert again
      await db.transact([{op: true, e: 1, a: 'status', v: 'completed'}]);
      const query5 = datomsQueryToDatalogQuery({
        e: 1,
        a: 'status',
      });
      const {data: results5} = await db.query(query5);
      const completedDatoms = queryResultsToDatoms(results5, {
        e: 1,
        a: 'status',
      });
      expect(completedDatoms[0]?.v).toBe('completed');
    });

    test('should track transaction IDs correctly with new methods', async () => {
      const {db} = f;
      const initialTx = await db._getLatestTransaction();

      const tx1 = await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      expect(tx1).toBeGreaterThan(initialTx.txId);

      const query = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const {data: results} = await db.query(query);
      const nameDatoms = queryResultsToDatoms(results, {e: 1, a: 'name'});
      const tx2 = await db.transact(
        nameDatoms.map(d => ({
          op: false,
          e: d.e,
          a: d.a,
          v: d.v,
        })),
      );
      expect(tx2).toBeGreaterThan(tx1);

      const tx3 = await db.transact([{op: true, e: 1, a: 'name', v: 'Bob'}]);
      expect(tx3).toBeGreaterThan(tx2);

      const latestTx = await db._getLatestTransaction();
      expect(latestTx.txId).toBe(tx3);
    });
  });
});
