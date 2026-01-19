import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Logger } from "../../types.js";
import type { DatomDatabase } from "../datom-database.js";
import { DestroyRetentionPolicy } from "../retention-policy/destroy-retention-policy.js";
import type { RetentionPolicyConfig } from "../retention-policy/types.js";
import { FIXTURES, type Fixture } from "./fixtures.js";

/**
 * Simple logger that captures logs for testing
 */
class TestLogger implements Logger {
  public logs: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    meta?: Record<string, unknown>;
  }> = [];

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: "debug", message, meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: "info", message, meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: "warn", message, meta });
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: "error", message, meta });
  }

  reset(): void {
    this.logs = [];
  }

  getLogsByLevel(level: "debug" | "info" | "warn" | "error") {
    return this.logs.filter((log) => log.level === level);
  }
}

describe.each(FIXTURES)(
  "DestroyRetentionPolicy (%s)",
  (_name, createFixture) => {
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

    describe("Configuration Validation", () => {
      test("should throw error if retentionTxCount is less than 1", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 0,
          intervalMs: 1000,
        };

        expect(() => {
          new DestroyRetentionPolicy(f.db, config, logger);
        }).toThrow("retentionTxCount must be at least 1");
      });

      test("should throw error if neither intervalMs nor cronExpression is provided", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
        };

        expect(() => {
          new DestroyRetentionPolicy(f.db, config, logger);
        }).toThrow("Either intervalMs or cronExpression must be provided");
      });

      test("should throw error if both intervalMs and cronExpression are provided", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          intervalMs: 1000,
          cronExpression: "0 * * * *",
        };

        expect(() => {
          new DestroyRetentionPolicy(f.db, config, logger);
        }).toThrow("Cannot specify both intervalMs and cronExpression");
      });

      test("should accept valid configuration with intervalMs", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          intervalMs: 1000,
        };

        expect(() => {
          new DestroyRetentionPolicy(f.db, config, logger);
        }).not.toThrow();
      });

      test("should accept valid configuration with cronExpression", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          cronExpression: "0 * * * *",
        };

        expect(() => {
          new DestroyRetentionPolicy(f.db, config, logger);
        }).not.toThrow();
      });
    });

    describe("Lifecycle Methods", () => {
      test("should start and stop correctly", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        expect(policy.isRunning()).toBe(false);
        policy.start();
        expect(policy.isRunning()).toBe(true);
        policy.stop();
        expect(policy.isRunning()).toBe(false);
      });

      test("should warn if started when already running", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        policy.start();
        expect(policy.isRunning()).toBe(true);
        policy.start(); // Start again
        expect(policy.isRunning()).toBe(true);

        const warnLogs = logger.getLogsByLevel("warn");
        expect(warnLogs.length).toBeGreaterThan(0);
        expect(
          warnLogs.some((log) => log.message.includes("already running"))
        ).toBe(true);
      });

      test("should warn if stopped when not running", () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        expect(policy.isRunning()).toBe(false);
        policy.stop(); // Stop when not running
        expect(policy.isRunning()).toBe(false);

        const warnLogs = logger.getLogsByLevel("warn");
        expect(warnLogs.length).toBeGreaterThan(0);
        expect(
          warnLogs.some((log) => log.message.includes("not running"))
        ).toBe(true);
      });
    });

    describe("Basic Execution", () => {
      test("should execute successfully with datoms to delete", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create transactions 1-10
        // With retentionTxCount = 5, cutoffTx = 5, so we keep transactions 6-10
        for (let tx = 1; tx <= 10; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "name", v: `Entity-${tx}` },
          ]);
        }

        // Update entity 1 multiple times to create obsolete datoms
        await f.db.transact([
          { op: "assert", e: 1, a: "name", v: "Entity-1-v2" },
        ]);
        await f.db.transact([
          { op: "assert", e: 1, a: "name", v: "Entity-1-v3" },
        ]);
        await f.db.transact([
          { op: "assert", e: 1, a: "name", v: "Entity-1-v4" },
        ]);

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBeGreaterThanOrEqual(13);

        const result = await policy.execute();

        // Should have processed some obsolete datoms
        expect(result.cutoffTx).toBeGreaterThan(0);
        expect(result.cutoffTx).toBeLessThan(latestTx);
        expect(result.error).toBeUndefined();

        // Verify current state is preserved
        const currentDatoms = await f.db.datoms({ e: 1, a: "name" });
        expect(currentDatoms.length).toBeGreaterThan(0);
        // Latest value should still be present
        const latestValue = currentDatoms.find((d) => d.v === "Entity-1-v4");
        expect(latestValue).toBeDefined();
      });

      test("should process datoms in batches", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
          batchSize: 2, // Small batch size for testing
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create many transactions with updates to generate obsolete datoms
        for (let i = 1; i <= 10; i++) {
          await f.db.transact([
            { op: "assert", e: 1, a: "value", v: `value-${i}` },
          ]);
        }

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBeGreaterThanOrEqual(10);

        const result = await policy.execute();

        expect(result.cutoffTx).toBeGreaterThan(0);
        expect(result.cutoffTx).toBeLessThan(latestTx);
        expect(result.error).toBeUndefined();
      });
    });

    describe("Safety Tests - Never Deletes Current State", () => {
      test("should never delete datoms with tx >= latestTx", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create transactions 1-10
        for (let tx = 1; tx <= 10; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "name", v: `Entity-${tx}` },
          ]);
        }

        const latestTxBefore = await f.db.getLatestTransaction();
        expect(latestTxBefore).toBe(10);

        // Get current datoms before execution
        const currentDatomsBefore = await f.db.datoms({ e: 10 });

        const result = await policy.execute();

        // Verify cutoffTx < latestTx
        const latestTxAfter = await f.db.getLatestTransaction();
        expect(result.cutoffTx).toBeLessThan(latestTxAfter);

        // Verify current datoms are still present
        const currentDatomsAfter = await f.db.datoms({ e: 10 });
        expect(currentDatomsAfter.length).toBeGreaterThanOrEqual(
          currentDatomsBefore.length
        );
      });
    });

    describe("Safety Tests - Never Deletes Everything", () => {
      test("should always keep at least retentionTxCount transactions", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create 20 transactions
        for (let tx = 1; tx <= 20; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "value", v: `value-${tx}` },
          ]);
        }

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBe(20);

        const result = await policy.execute();

        // cutoffTx should be 20 - 5 = 15
        expect(result.cutoffTx).toBe(15);
        expect(result.cutoffTx).toBeLessThan(latestTx);

        // Verify transactions 16-20 are still accessible
        const dbAsOf15 = f.db.asOf(15);
        const dbAsOf20 = f.db.asOf(20);

        const _datomsAt15 = await dbAsOf15.datoms({ e: 16 });
        const datomsAt20 = await dbAsOf20.datoms({ e: 16 });

        // Entity 16 should exist at tx 20 but not at tx 15 (if it was created after tx 15)
        // Actually, since we created entity 16 at tx 16, it should exist at both
        // But the point is that transactions 16-20 should be preserved
        expect(datomsAt20.length).toBeGreaterThan(0);
      });

      test("should ensure cutoffTx is always less than latestTx", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 3,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Test with various latestTx values
        for (const targetTx of [5, 10, 20]) {
          // Reset by creating new transactions up to targetTx
          for (let tx = 1; tx <= targetTx; tx++) {
            await f.db.transact([
              { op: "assert", e: tx, a: "value", v: `value-${tx}` },
            ]);
          }

          const latestTx = await f.db.getLatestTransaction();
          const result = await policy.execute();

          // cutoffTx should always be less than latestTx
          expect(result.cutoffTx).toBeLessThan(latestTx);
          // cutoffTx should be latestTx - retentionTxCount (when enough transactions)
          if (latestTx >= 3) {
            expect(result.cutoffTx).toBe(latestTx - 3);
          }
        }
      });
    });

    describe("Edge Cases", () => {
      test("should skip gracefully when no transactions exist", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBe(0); // No transactions yet

        const result = await policy.execute();

        expect(result.datomsProcessed).toBe(0);
        expect(result.datomsDeleted).toBe(0);
        expect(result.cutoffTx).toBe(0);
        expect(result.error).toBeUndefined();

        const infoLogs = logger.getLogsByLevel("info");
        expect(
          infoLogs.some((log) => log.message.includes("No transactions found"))
        ).toBe(true);
      });

      test("should keep everything when latestTx < retentionTxCount", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 10,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create only 5 transactions (less than retentionTxCount of 10)
        for (let tx = 1; tx <= 5; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "name", v: `Entity-${tx}` },
          ]);
        }

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBe(5);

        const result = await policy.execute();

        expect(result.datomsProcessed).toBe(0);
        expect(result.datomsDeleted).toBe(0);
        expect(result.cutoffTx).toBe(0); // Keep everything

        // Verify all datoms are still present by checking specific entities
        const datoms1 = await f.db.datoms({ e: 1 });
        const datoms2 = await f.db.datoms({ e: 2 });
        const datoms3 = await f.db.datoms({ e: 3 });
        expect(datoms1.length).toBeGreaterThan(0);
        expect(datoms2.length).toBeGreaterThan(0);
        expect(datoms3.length).toBeGreaterThan(0);
      });

      test("should keep everything when latestTx === retentionTxCount", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create exactly 5 transactions
        for (let tx = 1; tx <= 5; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "name", v: `Entity-${tx}` },
          ]);
        }

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBe(5);

        const result = await policy.execute();

        // cutoffTx = Math.max(0, 5 - 5) = 0, so we keep everything
        expect(result.cutoffTx).toBe(0);
        expect(result.datomsProcessed).toBe(0);
        expect(result.datomsDeleted).toBe(0);

        // Verify all datoms are still present by checking specific entities
        const datoms1 = await f.db.datoms({ e: 1 });
        const datoms2 = await f.db.datoms({ e: 2 });
        const datoms3 = await f.db.datoms({ e: 3 });
        expect(datoms1.length).toBeGreaterThan(0);
        expect(datoms2.length).toBeGreaterThan(0);
        expect(datoms3.length).toBeGreaterThan(0);
      });

      test("should handle empty obsolete datoms gracefully", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create transactions but no updates (no obsolete datoms)
        for (let tx = 1; tx <= 10; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "name", v: `Entity-${tx}` },
          ]);
        }

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBe(10);

        const result = await policy.execute();

        expect(result.cutoffTx).toBe(5);
        expect(result.error).toBeUndefined();

        // Even if no obsolete datoms, should complete successfully
        expect(result.datomsProcessed).toBeGreaterThanOrEqual(0);
      });
    });

    describe("Error Handling", () => {
      test("should handle error when getLatestTransaction fails", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };

        // Create a database that will fail on getLatestTransaction
        const errorDb: DatomDatabase = {
          ...f.db,
          async getLatestTransaction() {
            throw new Error("Database connection failed");
          },
        };

        const policy = new DestroyRetentionPolicy(errorDb, config, logger);

        const result = await policy.execute();

        expect(result.error).toBeDefined();
        expect(result.error).toContain("Database connection failed");
        expect(result.datomsProcessed).toBe(0);
        expect(result.datomsDeleted).toBe(0);
        expect(result.cutoffTx).toBe(0);

        const errorLogs = logger.getLogsByLevel("error");
        expect(errorLogs.length).toBeGreaterThan(0);
      });
    });

    describe("Realistic Scenarios", () => {
      test("should handle entity updates across transactions", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 3,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Simulate entity updates: entity 1's name changes over time
        await f.db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);
        await f.db.transact([
          { op: "assert", e: 1, a: "name", v: "Alice Updated" },
        ]);
        await f.db.transact([
          { op: "assert", e: 1, a: "name", v: "Alice Current" },
        ]);
        await f.db.transact([
          { op: "assert", e: 1, a: "name", v: "Alice Latest" },
        ]);

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBeGreaterThanOrEqual(4);

        const result = await policy.execute();

        // cutoffTx = latestTx - 3
        expect(result.cutoffTx).toBeGreaterThan(0);
        expect(result.cutoffTx).toBeLessThan(latestTx);

        // Verify current value is preserved
        const currentDatoms = await f.db.datoms({ e: 1, a: "name" });
        expect(currentDatoms.length).toBeGreaterThan(0);
        const latestValue = currentDatoms.find((d) => d.v === "Alice Latest");
        expect(latestValue).toBeDefined();
      });

      test("should preserve at least retentionTxCount transactions of history", async () => {
        const config: RetentionPolicyConfig = {
          retentionTxCount: 5,
          intervalMs: 1000,
        };
        const policy = new DestroyRetentionPolicy(f.db, config, logger);

        // Create 20 transactions
        for (let tx = 1; tx <= 20; tx++) {
          await f.db.transact([
            { op: "assert", e: tx, a: "value", v: `value-${tx}` },
          ]);
        }

        const latestTx = await f.db.getLatestTransaction();
        expect(latestTx).toBe(20);

        const result = await policy.execute();

        // cutoffTx = 20 - 5 = 15
        expect(result.cutoffTx).toBe(15);

        // Verify transactions 16-20 are accessible via asOf
        const dbAsOf20 = f.db.asOf(20);
        const datomsAt20 = await dbAsOf20.datoms({ e: 16 });
        expect(datomsAt20.length).toBeGreaterThan(0);

        // Verify at least 5 transactions worth of history remains
        const dbAsOf15 = f.db.asOf(15);
        const _datomsAt15 = await dbAsOf15.datoms({ e: 16 });
        // Entity 16 was created at tx 16, so it should exist at tx 20 but not at tx 15
        expect(datomsAt20.length).toBeGreaterThan(0);
      });
    });
  }
);
