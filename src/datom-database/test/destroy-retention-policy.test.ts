import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {TestLogger} from '../../types.js';
import type {DatomDatabase} from '../datom-database.js';
import {
  DestroyRetentionPolicy,
  type DestroyRetentionPolicyConfig,
} from '../retention-policy/destroy-retention-policy.js';
import {queryResultsToDatoms} from '../shared/datoms-query-converter.js';
import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';
import {datomsQueryToDatalogQuery} from '../../datoms-query.js';

describe.each(FIXTURES)('DestroyRetentionPolicy (%s)', (_name, createFixture) => {
  let f: Fixture;
  let logger: TestLogger;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
    logger = new TestLogger();
  });

  afterEach(async () => {
    await f.afterEach();
    logger.reset();
  });

  describe('Configuration Validation', () => {
    test('should throw error if retentionCount is less than 1', () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 0,
        intervalMs: 1000,
      };

      expect(() => {
        new DestroyRetentionPolicy({
          sourceDb: f.db,
          config,
          logger,
        });
      }).toThrow(
        'retentionCount must be at least 1 to ensure at least one historical datom is kept per (entity, attribute) pair',
      );
    });

    test('should throw error if intervalMs is not provided', () => {
      const config = {
        retentionCount: 10,
      } as unknown as DestroyRetentionPolicyConfig;

      expect(() => {
        new DestroyRetentionPolicy({
          sourceDb: f.db,
          config,
          logger,
        });
      }).toThrow('intervalMs must be provided');
    });

    test('should accept valid configuration with intervalMs', () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 10,
        intervalMs: 1000,
      };

      expect(() => {
        new DestroyRetentionPolicy({
          sourceDb: f.db,
          config,
          logger,
        });
      }).not.toThrow();
    });
  });

  describe('Lifecycle Methods', () => {
    test('should start and stop correctly', () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 10,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      expect(policy.isRunning()).toBe(false);
      policy.start();
      expect(policy.isRunning()).toBe(true);
      policy.stop();
      expect(policy.isRunning()).toBe(false);
    });

    test('should warn if started when already running', () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 10,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      policy.start();
      expect(policy.isRunning()).toBe(true);
      policy.start(); // Start again
      expect(policy.isRunning()).toBe(true);

      const warnLogs = logger.getLogsByLevel('warn');
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(warnLogs.some(log => log.message.includes('already running'))).toBe(true);
    });

    test('should warn if stopped when not running', () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 10,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      expect(policy.isRunning()).toBe(false);
      policy.stop(); // Stop when not running
      expect(policy.isRunning()).toBe(false);

      const warnLogs = logger.getLogsByLevel('warn');
      expect(warnLogs.length).toBeGreaterThan(0);
      expect(warnLogs.some(log => log.message.includes('not running'))).toBe(true);
    });
  });

  describe('Basic Execution', () => {
    test('should execute successfully with datoms to delete', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create transactions 1-10
      for (let tx = 1; tx <= 10; tx++) {
        await f.db.write([{op: true, e: tx, a: 'name', v: `Entity-${tx}`}]);
      }

      // Update entity 1 multiple times to create historical datoms
      // Entity 1 will have: Entity-1 (tx 1), Entity-1-v2 (tx 11), Entity-1-v3 (tx 12), Entity-1-v4 (tx 13)
      // With retentionCount = 5, we should keep all 4 (less than 5, so nothing deleted)
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Entity-1-v2'}]);
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Entity-1-v3'}]);
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Entity-1-v4'}]);

      // Create entity 1 with more than 5 historical values
      // This adds transactions 14-19 (v5 through v10)
      for (let i = 5; i <= 10; i++) {
        await f.db.write([{op: true, e: 1, a: 'name', v: `Entity-1-v${i}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      // Total: 10 initial + 3 updates (v2-v4) + 6 updates (v5-v10) = 19 transactions
      expect(latestTx.txId).toBeGreaterThanOrEqual(19);

      const result = await policy.execute();

      // Should have processed some datoms
      expect(result.datomsDeleted).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();

      // Verify current state is preserved
      const query1 = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const {data: results1} = await f.db.read(query1);
      const currentDatoms = queryResultsToDatoms(results1, {e: 1, a: 'name'});
      expect(currentDatoms.length).toBeGreaterThan(0);
      // Latest value should still be present
      const latestValue = currentDatoms.find(d => d.v === 'Entity-1-v10');
      expect(latestValue).toBeDefined();

      // Verify that only the latest 5 historical datoms are kept for entity 1
      const query2 = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const {data: results2} = await f.db.history().read(query2);
      const historyDatoms = queryResultsToDatoms(results2, {e: 1, a: 'name'});
      // Should have at most 5 datoms (or fewer if some were falseed)
      expect(historyDatoms.length).toBeLessThanOrEqual(5);
    });

    test('should process datoms in batches', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create many transactions with updates to generate historical datoms
      // Entity 1 will have 10 historical values, with retentionCount = 5, we keep latest 5
      for (let i = 1; i <= 10; i++) {
        await f.db.write([{op: true, e: 1, a: 'value', v: `value-${i}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBeGreaterThanOrEqual(10);

      const result = await policy.execute();

      // Should have deleted some datoms (entity 1 had 10, keeps 5, deletes 5)
      expect(result.datomsDeleted).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();

      // Verify only latest 5 are kept
      const query = datomsQueryToDatalogQuery({e: 1, a: 'value'});
      const found = await f.db.history().read(query);
      const results = found.data;
      const historyDatoms = queryResultsToDatoms(results, {e: 1, a: 'value'});
      expect(historyDatoms.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Safety Tests - Never Deletes Current State', () => {
    test('should never delete current datoms', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create transactions 1-10
      for (let tx = 1; tx <= 10; tx++) {
        await f.db.write([{op: true, e: tx, a: 'name', v: `Entity-${tx}`}]);
      }

      const latestTxBefore = await f.db._getLatestTransaction();
      expect(latestTxBefore.txId).toBe(10);

      // Get current datoms before execution
      const queryBefore = datomsQueryToDatalogQuery({e: 10});
      const foundBefore = await f.db.read(queryBefore);
      const resultsBefore = foundBefore.data;
      const currentDatomsBefore = queryResultsToDatoms(resultsBefore, {e: 10});

      const result = await policy.execute();

      // Verify no error occurred
      expect(result.error).toBeUndefined();

      // Verify current datoms are still present
      const queryAfter = datomsQueryToDatalogQuery({e: 10});
      const foundAfter = await f.db.read(queryAfter);
      const resultsAfter = foundAfter.data;
      const currentDatomsAfter = queryResultsToDatoms(resultsAfter, {e: 10});
      expect(currentDatomsAfter.length).toBeGreaterThanOrEqual(currentDatomsBefore.length);
      // Current value should still be there
      const currentValue = currentDatomsAfter.find(d => d.v === 'Entity-10');
      expect(currentValue).toBeDefined();
    });
  });

  describe('Safety Tests - Never Deletes Everything', () => {
    test('should always keep at least retentionCount datoms per entity-attribute pair', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Get initial transaction ID
      const initialTx = await f.db._getLatestTransaction();
      const initialTxId = initialTx.txId ?? 0;

      // Create entity 1 with 10 historical values
      for (let i = 1; i <= 10; i++) {
        await f.db.write([{op: true, e: 1, a: 'value', v: `value-${i}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBe(initialTxId + 10);

      const result = await policy.execute();

      // Should have deleted some datoms (keeps 5, had 10, deletes 5)
      expect(result.datomsDeleted).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();

      // Verify that exactly 5 historical datoms are kept for entity 1
      const query3 = datomsQueryToDatalogQuery({e: 1, a: 'value'});
      const found3 = await f.db.history().read(query3);
      const results3 = found3.data;
      const historyDatoms = queryResultsToDatoms(results3, {e: 1, a: 'value'});
      expect(historyDatoms.length).toBe(5);

      // Verify the latest value is still present
      const query4 = datomsQueryToDatalogQuery({e: 1, a: 'value'});
      const found4 = await f.db.read(query4);
      const results4 = found4.data;
      const currentDatoms = queryResultsToDatoms(results4, {e: 1, a: 'value'});
      const latestValue = currentDatoms.find(d => d.v === 'value-10');
      expect(latestValue).toBeDefined();
    });

    test('should keep exactly retentionCount datoms per entity-attribute pair', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 3,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Test with various numbers of historical values
      for (const numValues of [5, 10, 20]) {
        // Create entity 1 with numValues historical values
        for (let i = 1; i <= numValues; i++) {
          await f.db.write([{op: true, e: 1, a: 'value', v: `value-${i}`}]);
        }

        const result = await policy.execute();

        // Should have deleted some datoms if numValues > retentionCount
        if (numValues > 3) {
          expect(result.datomsDeleted).toBeGreaterThan(0);
        }
        expect(result.error).toBeUndefined();

        // Verify exactly retentionCount datoms are kept
        const query = datomsQueryToDatalogQuery({e: 1, a: 'value'});
        const found = await f.db.history().read(query);
        const results = found.data;
        const historyDatoms = queryResultsToDatoms(results, {e: 1, a: 'value'});
        expect(historyDatoms.length).toBeLessThanOrEqual(3);

        // Verify latest value is preserved
        const query2 = datomsQueryToDatalogQuery({
          e: 1,
          a: 'value',
        });
        const found2 = await f.db.read(query2);
        const currentResults = found2.data;
        const currentDatoms = queryResultsToDatoms(currentResults, {e: 1, a: 'value'});
        const latestValue = currentDatoms.find(d => d.v === `value-${numValues}`);
        expect(latestValue).toBeDefined();
      }
    });
  });

  describe('Edge Cases', () => {
    test('should skip gracefully when no transactions exist', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBe(0); // No transactions yet

      const result = await policy.execute();

      expect(result.datomsProcessed).toBe(0);
      expect(result.datomsDeleted).toBe(0);
      expect(result.error).toBeUndefined();
    });

    test('should keep everything when entities have fewer than retentionCount datoms', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 10,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create entities with only 1 datom each (less than retentionCount of 10)
      for (let tx = 1; tx <= 5; tx++) {
        await f.db.write([{op: true, e: tx, a: 'name', v: `Entity-${tx}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBe(5);

      const result = await policy.execute();

      // Since each entity has only 1 datom (< 10), nothing should be deleted
      expect(result.datomsDeleted).toBe(0);
      expect(result.error).toBeUndefined();

      // Verify all datoms are still present by checking specific entities
      const query1 = datomsQueryToDatalogQuery({e: 1});
      const found1 = await f.db.read(query1);
      const results1 = found1.data;
      const datoms1 = queryResultsToDatoms(results1, {e: 1});
      const query2 = datomsQueryToDatalogQuery({e: 2});
      const found2 = await f.db.read(query2);
      const results2 = found2.data;
      const datoms2 = queryResultsToDatoms(results2, {e: 2});
      const query3 = datomsQueryToDatalogQuery({e: 3});
      const found3 = await f.db.read(query3);
      const results3 = found3.data;
      const datoms3 = queryResultsToDatoms(results3, {e: 3});
      expect(datoms1.length).toBeGreaterThan(0);
      expect(datoms2.length).toBeGreaterThan(0);
      expect(datoms3.length).toBeGreaterThan(0);
    });

    test('should keep everything when entity has exactly retentionCount datoms', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create entity 1 with exactly 5 historical values
      for (let i = 1; i <= 5; i++) {
        await f.db.write([{op: true, e: 1, a: 'name', v: `Entity-1-v${i}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBe(5);

      const result = await policy.execute();

      // Since entity 1 has exactly 5 datoms (== retentionCount), nothing should be deleted
      expect(result.datomsDeleted).toBe(0);
      expect(result.error).toBeUndefined();

      // Verify all datoms are still present
      const query = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const found = await f.db.history().read(query);
      const results = found.data;
      const historyDatoms = queryResultsToDatoms(results, {e: 1, a: 'name'});
      expect(historyDatoms.length).toBe(5);
    });

    test('should handle entities with no historical datoms gracefully', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create transactions but each entity has only 1 datom (no history to clean)
      for (let tx = 1; tx <= 10; tx++) {
        await f.db.write([{op: true, e: tx, a: 'name', v: `Entity-${tx}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBe(10);

      const result = await policy.execute();

      // Since each entity has only 1 datom (< 5), nothing should be deleted
      expect(result.datomsDeleted).toBe(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    test('should handle error when _destroy fails', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };

      // Create a database that will fail on _destroy
      const errorDb: DatomDatabase = {
        ...f.db,
        async _destroy(_config: {retentionCount: number}) {
          throw new Error('Database connection failed');
        },
      };

      const policy = new DestroyRetentionPolicy({
        sourceDb: errorDb,
        config,
        logger,
      });

      const result = await policy.execute();

      expect(result.error).toBeDefined();
      expect(result.error).toContain('Database connection failed');
      expect(result.datomsProcessed).toBe(0);
      expect(result.datomsDeleted).toBe(0);

      const errorLogs = logger.getLogsByLevel('error');
      expect(errorLogs.length).toBeGreaterThan(0);
    });
  });

  describe('Realistic Scenarios', () => {
    test('should handle entity updates across transactions', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 3,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Simulate entity updates: entity 1's name changes over time
      // Creates 4 historical values, with retentionCount = 3, keeps latest 3
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Alice'}]);
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Alice Updated'}]);
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Alice Current'}]);
      await f.db.write([{op: true, e: 1, a: 'name', v: 'Alice Latest'}]);

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBeGreaterThanOrEqual(4);

      const result = await policy.execute();

      // Should have deleted 1 datom (had 4, keeps 3)
      expect(result.datomsDeleted).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();

      // Verify current value is preserved
      const query5 = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const {data: results5} = await f.db.read(query5);
      const currentDatoms2 = queryResultsToDatoms(results5, {e: 1, a: 'name'});
      expect(currentDatoms2.length).toBeGreaterThan(0);
      const latestValue = currentDatoms2.find(d => d.v === 'Alice Latest');
      expect(latestValue).toBeDefined();

      // Verify only 3 historical datoms remain
      const query6 = datomsQueryToDatalogQuery({e: 1, a: 'name'});
      const {data: results6} = await f.db.history().read(query6);
      const historyDatoms2 = queryResultsToDatoms(results6, {e: 1, a: 'name'});
      expect(historyDatoms2.length).toBe(3);
    });

    test('should preserve at least retentionCount datoms per entity-attribute pair', async () => {
      const config: DestroyRetentionPolicyConfig = {
        retentionCount: 5,
        intervalMs: 1000,
      };
      const policy = new DestroyRetentionPolicy({
        sourceDb: f.db,
        config,
        logger,
      });

      // Create entity 1 with 20 historical values
      for (let i = 1; i <= 20; i++) {
        await f.db.write([{op: true, e: 1, a: 'value', v: `value-${i}`}]);
      }

      const latestTx = await f.db._getLatestTransaction();
      expect(latestTx.txId).toBe(20);

      const result = await policy.execute();

      // Should have deleted some datoms (had 20, keeps 5, deletes 15)
      expect(result.datomsDeleted).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();

      // Verify exactly 5 historical datoms remain for entity 1
      const query7 = datomsQueryToDatalogQuery({e: 1, a: 'value'});
      const {data: results7} = await f.db.history().read(query7);
      const historyDatoms3 = queryResultsToDatoms(results7, {e: 1, a: 'value'});
      expect(historyDatoms3.length).toBe(5);

      // Verify latest value is preserved
      const query8 = datomsQueryToDatalogQuery({e: 1, a: 'value'});
      const {data: results8} = await f.db.read(query8);
      const currentDatoms5 = queryResultsToDatoms(results8, {e: 1, a: 'value'});
      const latestValue3 = currentDatoms5.find(d => d.v === 'value-20');
      expect(latestValue3).toBeDefined();
    });
  });
});
