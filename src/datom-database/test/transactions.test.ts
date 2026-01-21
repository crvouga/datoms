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

  describe('With API (Speculative Transactions)', () => {
    test('should execute successful transaction', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      // Use with() to see what the transaction would look like
      const query1 = datomsQueryToDatalogQuery({e: 1});
      const {data: results1} = await db.query(query1);
      const initial = queryResultsToDatoms(results1, {e: 1});
      expect(initial).toHaveLength(1);

      const withResult = await db.with([{op: true, e: 1, a: 'status', v: 'pending'}]);
      const query2 = datomsQueryToDatalogQuery({e: 1});
      const {data: results2} = await withResult.dbAfter.query(query2);
      const updated = queryResultsToDatoms(results2, {e: 1});
      expect(updated).toHaveLength(2);

      // Now commit the changes
      await db.transact([{op: true, e: 1, a: 'status', v: 'pending'}]);

      // Verify changes are committed
      const query3 = datomsQueryToDatalogQuery({e: 1});
      const {data: results3} = await db.query(query3);
      const final = queryResultsToDatoms(results3, {e: 1});
      expect(final).toHaveLength(2);
      const values = final.map(d => d.v);
      expect(values).toContain('Alice');
      expect(values).toContain('pending');
    });

    test('should not commit changes when using with()', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      // Use with() to see what the transaction would look like
      const withResult = await db.with([{op: true, e: 1, a: 'status', v: 'pending'}]);

      // Query dbAfter to see speculative state
      const query4 = datomsQueryToDatalogQuery({e: 1});
      const {data: results4} = await withResult.dbAfter.query(query4);
      const speculative = queryResultsToDatoms(results4, {e: 1});
      expect(speculative).toHaveLength(2);

      // But actual database should not be changed (with() doesn't commit)
      const query5 = datomsQueryToDatalogQuery({e: 1});
      const {data: results5} = await db.query(query5);
      const final = queryResultsToDatoms(results5, {e: 1});
      expect(final).toHaveLength(1);
      expect(final[0]?.v).toBe('Alice');
    });

    test('should see speculative changes with with()', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      // Query before adding
      const query6 = datomsQueryToDatalogQuery({e: 1});
      const {data: results6} = await db.query(query6);
      const before = queryResultsToDatoms(results6, {e: 1});
      expect(before).toHaveLength(1);

      // Use with() to see what adding would look like
      const withResult = await db.with([{op: true, e: 1, a: 'age', v: 30}]);

      // Query dbAfter - should see speculative change
      const query7 = datomsQueryToDatalogQuery({e: 1});
      const {data: results7} = await withResult.dbAfter.query(query7);
      const after = queryResultsToDatoms(results7, {e: 1});
      expect(after).toHaveLength(2);
      const values = after.map(d => d.v);
      expect(values).toContain('Alice');
      expect(values).toContain(30);
    });

    test('should handle sub with with()', async () => {
      const {db} = f;

      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 1, a: 'age', v: 30},
      ]);

      // Use with() to see what subion would look like
      const withResult = await db.with([{op: false, e: 1, a: 'age', v: 30}]);

      // Query dbAfter should not see sub datom
      const query8 = datomsQueryToDatalogQuery({e: 1});
      const {data: results8} = await withResult.dbAfter.query(query8);
      const result = queryResultsToDatoms(results8, {e: 1});
      expect(result).toHaveLength(1);
      expect(result[0]?.v).toBe('Alice');

      // Now commit the subion
      await db.transact([{op: false, e: 1, a: 'age', v: 30}]);

      // Verify subion is committed
      const query9 = datomsQueryToDatalogQuery({e: 1});
      const {data: results9} = await db.query(query9);
      const final = queryResultsToDatoms(results9, {e: 1});
      expect(final).toHaveLength(1);
      expect(final[0]?.v).toBe('Alice');
    });

    test('should handle query with with()', async () => {
      const {db} = f;

      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
      ]);

      // Use with() to see what adding would look like
      const withResult = await db.with([{op: true, e: 3, a: 'name', v: 'Charlie'}]);

      // Query dbAfter should see speculative change
      const {data: results} = await withResult.dbAfter.query({
        find: {x: ['?x']},
        where: [{e: '?x', a: 'name', v: '?y'}],
      });

      expect(results).toHaveLength(3);
      const entities = results.map(r => r.x).sort();
      expect(entities).toEqual([1, 2, 3]);
    });

    test('should handle multiple operations with transact()', async () => {
      const {db} = f;

      // First add initial data
      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 1, a: 'age', v: 30},
      ]);

      // Then update in a single transaction: sub old age, add new age, add Bob
      await db.transact([
        {op: true, e: 1, a: 'age', v: 31},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: false, e: 1, a: 'age', v: 30},
      ]);

      // Verify all operations were applied
      const query1 = datomsQueryToDatalogQuery({e: 1});
      const {data: results1} = await db.query(query1);
      const alice = queryResultsToDatoms(results1, {e: 1});
      expect(alice).toHaveLength(2);
      const aliceValues = alice.map(d => d.v);
      expect(aliceValues).toContain('Alice');
      expect(aliceValues).toContain(31);
      expect(aliceValues).not.toContain(30);

      const query2 = datomsQueryToDatalogQuery({e: 2});
      const {data: results2} = await db.query(query2);
      const bob = queryResultsToDatoms(results2, {e: 2});
      expect(bob).toHaveLength(1);
      expect(bob[0]?.v).toBe('Bob');
    });

    test('should not commit changes when using with()', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Initial'}]);

      // Use with() to see what the transaction would look like
      const withResult = await db.with([
        {op: true, e: 1, a: 'status', v: 'pending'},
        {op: true, e: 2, a: 'name', v: 'New'},
        {op: false, e: 1, a: 'name', v: 'Initial'},
      ]);

      // Query dbAfter to see speculative state
      const query10 = datomsQueryToDatalogQuery({e: 1});
      const {data: results10} = await withResult.dbAfter.query(query10);
      const speculative = queryResultsToDatoms(results10, {e: 1});
      expect(speculative.length).toBeGreaterThan(0);

      // But actual database should not be changed (with() doesn't commit)
      const query11 = datomsQueryToDatalogQuery({e: 1});
      const {data: results11} = await db.query(query11);
      const result = queryResultsToDatoms(results11, {e: 1});
      expect(result).toHaveLength(1);
      expect(result[0]?.v).toBe('Initial');

      const query2 = datomsQueryToDatalogQuery({e: 2});
      const {data: results2} = await db.query(query2);
      const entity2 = queryResultsToDatoms(results2, {e: 2});
      expect(entity2).toHaveLength(0);
    });

    test('should handle query with with()', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const {data: nameResults} = await db.query({
        find: {v: ['?v']},
        where: [{e: 1, a: 'name', v: '?v'}],
      });
      expect(nameResults[0]?.v).toBe('Alice');

      // Use with() to see what adding age would look like
      const withResult = await db.with([{op: true, e: 1, a: 'age', v: 30}]);
      const {data: ageResults} = await withResult.dbAfter.query({
        find: {v: ['?v']},
        where: [{e: 1, a: 'age', v: '?v'}],
      });
      expect(ageResults[0]?.v).toBe(30);
    });

    test('should handle datoms query with with()', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const query1 = datomsQueryToDatalogQuery({e: 1, op: true});
      const {data: results1} = await db.query(query1);
      let entity = queryResultsToDatoms(results1, {e: 1, op: true});
      expect(entity).toHaveLength(1);

      // Use with() to see what adding age would look like
      const withResult = await db.with([{op: true, e: 1, a: 'age', v: 30}]);
      const query2 = datomsQueryToDatalogQuery({e: 1, op: true});
      const {data: results2} = await withResult.dbAfter.query(query2);
      entity = queryResultsToDatoms(results2, {e: 1, op: true});
      expect(entity).toHaveLength(2);
    });

    test('should handle hasFact with with()', async () => {
      const {db} = f;

      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const query = datomsQueryToDatalogQuery({
        e: 1,
        a: 'name',
        v: 'Alice',
      });
      const {data: nameResults} = await db.query(query);
      const nameDatoms = queryResultsToDatoms(nameResults, {e: 1, a: 'name', v: 'Alice'});
      expect(nameDatoms.length).toBeGreaterThan(0);

      // Use with() to see what adding status would look like
      const withResult = await db.with([{op: true, e: 1, a: 'status', v: 'active'}]);
      const queryStatus = datomsQueryToDatalogQuery({
        e: 1,
        a: 'status',
        v: 'active',
      });
      const {data: statusResults} = await withResult.dbAfter.query(queryStatus);
      const statusDatoms = queryResultsToDatoms(statusResults, {e: 1, a: 'status', v: 'active'});
      expect(statusDatoms.length).toBeGreaterThan(0);
    });

    test('should handle complex query with with()', async () => {
      const {db} = f;

      await db.transact([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 1, a: 'department', v: 'Engineering'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 2, a: 'department', v: 'Sales'},
      ]);

      // Use with() to see what adding new employee would look like
      const withResult = await db.with([
        {op: true, e: 3, a: 'name', v: 'Charlie'},
        {op: true, e: 3, a: 'department', v: 'Engineering'},
      ]);

      // Query dbAfter should see speculative change
      const {data: results} = await withResult.dbAfter.query({
        find: {name: ['?name']},
        where: [
          {e: '?e', a: 'name', v: '?name'},
          {e: '?e', a: 'department', v: 'Engineering'},
        ],
      });
      expect(results).toHaveLength(2);
      const names = results.map(r => r.name).sort();
      expect(names).toEqual(['Alice', 'Charlie']);
    });
  });

  describe('getLatestTransaction', () => {
    test('should return 0 for empty database', async () => {
      const {db} = f;
      const latestTx = await db._getLatestTransaction();
      expect(latestTx.txId).toBe(0);
      expect(latestTx.datoms).toEqual([]);
    });

    test('should return latest transaction ID after adding datoms', async () => {
      const {db} = f;
      const tx1 = await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      const latestTx = await db._getLatestTransaction();
      expect(latestTx.txId).toBe(tx1);
      expect(latestTx.datoms.length).toBeGreaterThan(0);

      const tx2 = await db.transact([{op: true, e: 2, a: 'name', v: 'Bob'}]);
      const latestTx2 = await db._getLatestTransaction();
      expect(latestTx2.txId).toBe(tx2);
      expect(latestTx2.txId).toBeGreaterThan(tx1);
    });

    test('should return latest transaction after false', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      const tx2 = await db.transact([{op: false, e: 1, a: 'name', v: 'Alice'}]);
      const latestTx = await db._getLatestTransaction();
      expect(latestTx.txId).toBe(tx2);
    });

    test('should return latest transaction after transact', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      const tx2 = await db.transact([
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: false, e: 1, a: 'name', v: 'Alice'},
      ]);
      const latestTx = await db._getLatestTransaction();
      expect(latestTx.txId).toBe(tx2);
    });

    test('should work with transact()', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      const beforeTx = await db._getLatestTransaction();

      // Use transact() to commit changes
      const txId = await db.transact([{op: true, e: 2, a: 'name', v: 'Bob'}]);
      expect(txId).toBeGreaterThan(beforeTx.txId);

      // After commit, latest should be updated
      const afterTx = await db._getLatestTransaction();
      expect(afterTx.txId).toBeGreaterThan(beforeTx.txId);
      expect(afterTx.txId).toBe(txId);
    });
  });

  describe('With Result', () => {
    test('should return dbBefore and dbAfter', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const withResult = await db.with([{op: true, e: 1, a: 'age', v: 30}]);

      // dbBefore should show current state
      const queryBefore = datomsQueryToDatalogQuery({e: 1});
      const {data: resultsBefore} = await withResult.dbBefore.query(queryBefore);
      const before = queryResultsToDatoms(resultsBefore, {e: 1});
      expect(before).toHaveLength(1);
      expect(before[0]?.v).toBe('Alice');

      // dbAfter should show speculative state
      const query = datomsQueryToDatalogQuery({e: 1});
      const {data: results} = await withResult.dbAfter.query(query);
      const after = queryResultsToDatoms(results, {e: 1});
      expect(after).toHaveLength(2);
      const values = after.map(d => d.v);
      expect(values).toContain('Alice');
      expect(values).toContain(30);
    });

    test('should return txData', async () => {
      const {db} = f;
      await db.transact([{op: true, e: 1, a: 'name', v: 'Alice'}]);

      const withResult = await db.with([
        {op: true, e: 1, a: 'age', v: 30},
        {op: false, e: 1, a: 'name', v: 'Alice'},
      ]);

      // txData should contain the datoms that would be applied
      expect(withResult.txData.length).toBeGreaterThan(0);
      const hasAdd = withResult.txData.some(
        d => d.e === 1 && d.a === 'age' && d.v === 30 && d.op === true,
      );
      expect(hasAdd).toBe(true);
      const hassub = withResult.txData.some(
        d => d.e === 1 && d.a === 'name' && d.v === 'Alice' && d.op === false,
      );
      expect(hassub).toBe(true);
    });

    test('should return tempIds (empty for now)', async () => {
      const {db} = f;
      const withResult = await db.with([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      expect(withResult.tempIds).toEqual({});
    });
  });
});
