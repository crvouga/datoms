/**
 * Destroy retention policy implementation
 * Permanently deletes obsolete historic datoms without archiving
 *
 * Safety guarantees:
 * - Never deletes current datoms (always keeps at least retentionTxCount transactions)
 * - Requires retentionTxCount >= 1 to prevent deleting all history
 * - Validates that cutoffTx < latestTx before deletion
 * - Includes runtime safety checks to prevent deleting current datoms
 * - Only prunes history, never deletes all transactions
 */

import type { Datom } from "../../datoms.js";
import type { Logger } from "../../types.js";
import type { DatomDatabase } from "../datom-database.js";
import type { DatomsParams } from "../views/database-view.js";
import type { RetentionPolicy } from "./retention-policy.js";
import type { RetentionPolicyConfig, RetentionResult } from "./types.js";

/**
 * Compute obsolete datoms from a list of datoms.
 * A datom is obsolete if it has been superseded by a later transaction for the same (entity, attribute, value).
 * @param datoms Array of datoms to analyze
 * @returns Array of obsolete datoms (all datoms that are not the latest for their (e, a, v) group)
 */
function computeObsoleteDatoms(datoms: Datom[]): Datom[] {
  // Group datoms by (entity, attribute, value)
  const datomsByKey = new Map<string, Datom[]>();
  for (const datom of datoms) {
    const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
    if (!datomsByKey.has(key)) {
      datomsByKey.set(key, []);
    }
    datomsByKey.get(key)!.push(datom);
  }

  // For each (e, a, v) group, find the latest transaction
  // All datoms with tx < latestTx are obsolete
  const obsoleteDatoms: Datom[] = [];
  for (const [_key, groupDatoms] of datomsByKey.entries()) {
    if (groupDatoms.length === 0) {
      continue;
    }

    // Sort by transaction ID descending
    groupDatoms.sort((a, b) => b.tx - a.tx);

    // Get the latest transaction ID for this (e, a, v)
    const latestDatom = groupDatoms[0];
    if (!latestDatom) {
      continue;
    }

    // All datoms with tx < latestTx are obsolete (they've been superseded)
    for (let i = 1; i < groupDatoms.length; i++) {
      const datom = groupDatoms[i];
      if (datom) {
        obsoleteDatoms.push(datom);
      }
    }
  }

  // Remove duplicates using a unique key
  const uniqueObsolete = new Map<string, Datom>();
  for (const datom of obsoleteDatoms) {
    const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}|${datom.tx}|${datom.op}`;
    uniqueObsolete.set(key, datom);
  }

  return Array.from(uniqueObsolete.values());
}

/**
 * Destroy retention policy
 * Permanently deletes obsolete historic datoms from the database
 */
export class DestroyRetentionPolicy implements RetentionPolicy {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sourceDb: DatomDatabase,
    private readonly config: RetentionPolicyConfig,
    private readonly logger: Logger
  ) {
    // Ensure we always keep at least 1 transaction worth of history
    // This prevents accidentally deleting all history
    if (config.retentionTxCount < 1) {
      throw new Error(
        "retentionTxCount must be at least 1 to ensure history is never fully deleted"
      );
    }
    if (!config.intervalMs && !config.cronExpression) {
      throw new Error("Either intervalMs or cronExpression must be provided");
    }
    if (config.intervalMs && config.cronExpression) {
      throw new Error("Cannot specify both intervalMs and cronExpression");
    }
  }

  start(): void {
    if (this.running) {
      this.logger?.warn("Retention policy already running", {
        event: "retention_policy_already_running",
        policy: "destroy",
      });
      return;
    }

    this.running = true;
    this.logger?.info("Starting destroy retention policy", {
      event: "retention_policy_starting",
      policy: "destroy",
      retentionTxCount: this.config.retentionTxCount,
      intervalMs: this.config.intervalMs,
      cronExpression: this.config.cronExpression,
      batchSize: this.config.batchSize,
    });

    if (this.config.intervalMs) {
      // Use interval-based scheduling
      this.intervalId = setInterval(() => {
        this.execute().catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger?.error("Destroy retention policy execution failed", {
            event: "retention_policy_execution_error",
            policy: "destroy",
            error: errorMessage,
            errorType: err instanceof Error ? err.constructor.name : typeof err,
          });
        });
      }, this.config.intervalMs);
    } else if (this.config.cronExpression) {
      // For cron expressions, we'll use a simple interval-based approach
      // In a production system, you'd want to use a proper cron library
      const intervalMs = this.parseCronExpression(this.config.cronExpression);
      if (intervalMs === null) {
        const error = new Error(
          `Invalid cron expression: ${this.config.cronExpression}`
        );
        this.logger?.error("Invalid cron expression", {
          event: "retention_policy_invalid_cron",
          policy: "destroy",
          cronExpression: this.config.cronExpression,
          error: error.message,
        });
        throw error;
      }
      this.intervalId = setInterval(() => {
        this.execute().catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger?.error("Destroy retention policy execution failed", {
            event: "retention_policy_execution_error",
            policy: "destroy",
            error: errorMessage,
            errorType: err instanceof Error ? err.constructor.name : typeof err,
          });
        });
      }, intervalMs);
    }
  }

  stop(): void {
    if (!this.running) {
      this.logger?.warn("Retention policy not running", {
        event: "retention_policy_not_running",
        policy: "destroy",
      });
      return;
    }

    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.logger?.info("Stopped destroy retention policy", {
      event: "retention_policy_stopped",
      policy: "destroy",
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  async execute(): Promise<RetentionResult> {
    const startTime = Date.now();
    this.logger?.debug("Starting retention policy execution", {
      event: "retention_policy_execution_start",
      policy: "destroy",
      retentionTxCount: this.config.retentionTxCount,
    });

    try {
      // Get latest transaction ID
      const latestTx = await this.sourceDb.getLatestTransaction();
      this.logger?.debug("Retrieved latest transaction", {
        event: "retention_policy_latest_tx_retrieved",
        policy: "destroy",
        latestTx,
      });

      if (latestTx === 0) {
        this.logger?.info("No transactions found, skipping retention", {
          event: "retention_policy_no_transactions",
          policy: "destroy",
        });
        return {
          datomsProcessed: 0,
          datomsDeleted: 0,
          cutoffTx: 0,
        };
      }

      // Calculate cutoff transaction ID
      // Ensure we always keep at least retentionTxCount transactions
      // This means cutoffTx must be strictly less than latestTx
      // If latestTx < retentionTxCount, we keep everything (cutoffTx = 0)
      const cutoffTx = Math.max(0, latestTx - this.config.retentionTxCount);

      // Safety check: Never delete current datoms
      // Ensure cutoffTx is strictly less than latestTx to avoid deleting current transaction
      if (cutoffTx >= latestTx) {
        this.logger?.info(
          "Cutoff transaction would delete current datoms, skipping retention",
          {
            event: "retention_policy_cutoff_too_high",
            policy: "destroy",
            latestTx,
            retentionTxCount: this.config.retentionTxCount,
            cutoffTx,
          }
        );
        return {
          datomsProcessed: 0,
          datomsDeleted: 0,
          cutoffTx: 0,
        };
      }

      this.logger?.debug("Calculated cutoff transaction", {
        event: "retention_policy_cutoff_calculated",
        policy: "destroy",
        latestTx,
        retentionTxCount: this.config.retentionTxCount,
        cutoffTx,
        transactionsToKeep: latestTx - cutoffTx,
      });

      if (cutoffTx === 0) {
        this.logger?.info(
          "Cutoff transaction is 0, keeping all history (not enough transactions to prune)",
          {
            event: "retention_policy_cutoff_zero",
            policy: "destroy",
            latestTx,
            retentionTxCount: this.config.retentionTxCount,
          }
        );
        return {
          datomsProcessed: 0,
          datomsDeleted: 0,
          cutoffTx: 0,
        };
      }

      // Get all datoms up to cutoff transaction using history view
      const allDatoms = await this.sourceDb
        .history()
        .datoms({ txMax: cutoffTx });

      // Compute obsolete datoms: group by (e, a, v), find latest tx per group, return non-latest
      const obsoleteDatoms = computeObsoleteDatoms(allDatoms);

      // Safety check: Verify no current datoms are included
      // This is a defensive check - getObsoleteDatoms should never return these
      const currentDatoms = obsoleteDatoms.filter((d) => d.tx >= latestTx);
      if (currentDatoms.length > 0) {
        const error = new Error(
          `Safety check failed: Found ${currentDatoms.length} current datoms in obsolete list. This should never happen.`
        );
        this.logger?.error(
          "Safety check failed: current datoms in obsolete list",
          {
            event: "retention_policy_safety_check_failed",
            policy: "destroy",
            latestTx,
            cutoffTx,
            currentDatomsCount: currentDatoms.length,
            error: error.message,
          }
        );
        throw error;
      }

      const batchSize = this.config.batchSize ?? 1000;

      this.logger?.info("Retrieved obsolete datoms", {
        event: "retention_policy_obsolete_datoms_retrieved",
        policy: "destroy",
        cutoffTx,
        latestTx,
        obsoleteDatomsCount: obsoleteDatoms.length,
        batchSize,
        transactionsToKeep: latestTx - cutoffTx,
      });

      let deleted = 0;

      // Group obsolete datoms by transaction ID ranges for efficient query-based deletion
      // This allows us to delete batches using txMax queries instead of passing arrays
      const txGroups = new Map<number, Datom[]>();
      for (const datom of obsoleteDatoms) {
        const tx = datom.tx;
        if (!txGroups.has(tx)) {
          txGroups.set(tx, []);
        }
        txGroups.get(tx)!.push(datom);
      }

      // Sort transaction IDs to process in order
      const sortedTxs = Array.from(txGroups.keys()).sort((a, b) => a - b);
      const totalBatches = Math.ceil(
        sortedTxs.length / Math.ceil(batchSize / 100)
      ); // Approximate batches

      let batchNumber = 0;
      let currentBatch: Datom[] = [];

      // Process obsolete datoms grouped by transaction ID
      for (const tx of sortedTxs) {
        const txDatoms = txGroups.get(tx)!;
        currentBatch.push(...txDatoms);

        // When batch reaches size limit, delete it
        if (currentBatch.length >= batchSize) {
          batchNumber++;
          const batchToDelete = currentBatch.slice(0, batchSize);
          currentBatch = currentBatch.slice(batchSize);

          this.logger?.debug("Processing batch", {
            event: "retention_policy_batch_processing",
            policy: "destroy",
            batchNumber,
            totalBatches,
            batchSize: batchToDelete.length,
            cutoffTx,
          });

          // Safety check: Verify batch doesn't contain current datoms before deletion
          const batchCurrentDatoms = batchToDelete.filter(
            (d) => d.tx >= latestTx
          );
          if (batchCurrentDatoms.length > 0) {
            const error = new Error(
              `Safety check failed: Attempted to delete ${batchCurrentDatoms.length} current datoms in batch ${batchNumber}. This should never happen.`
            );
            this.logger?.error(
              "Safety check failed: current datoms in deletion batch",
              {
                event: "retention_policy_batch_safety_check_failed",
                policy: "destroy",
                batchNumber,
                latestTx,
                cutoffTx,
                currentDatomsCount: batchCurrentDatoms.length,
                error: error.message,
              }
            );
            throw error;
          }

          // Group batch by (e, a, v, tx, op) to construct efficient queries
          // For each unique combination, delete using a query
          const datomGroups = new Map<string, Datom[]>();
          for (const datom of batchToDelete) {
            const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}|${datom.tx}|${datom.op}`;
            if (!datomGroups.has(key)) {
              datomGroups.set(key, []);
            }
            datomGroups.get(key)!.push(datom);
          }

          // Delete each group using a query
          // Since we have exact matches, we can construct queries with e, a, v, tx, op
          for (const [, groupDatoms] of datomGroups.entries()) {
            if (groupDatoms.length === 0) continue;
            const datom = groupDatoms[0]!;

            // Construct query to match this exact datom
            const deleteQuery: DatomsParams = {
              e: datom.e,
              a: datom.a,
              v: datom.v,
              tx: datom.tx,
              op: datom.op,
            };

            await this.sourceDb._destroy(deleteQuery);
          }

          deleted += batchToDelete.length;

          this.logger?.debug("Batch deleted", {
            event: "retention_policy_batch_deleted",
            policy: "destroy",
            batchNumber,
            totalBatches,
            batchSize: batchToDelete.length,
            deletedSoFar: deleted,
          });
        }
      }

      // Delete remaining datoms in final batch
      if (currentBatch.length > 0) {
        batchNumber++;
        this.logger?.debug("Processing final batch", {
          event: "retention_policy_batch_processing",
          policy: "destroy",
          batchNumber,
          totalBatches,
          batchSize: currentBatch.length,
          cutoffTx,
        });

        // Safety check
        const batchCurrentDatoms = currentBatch.filter((d) => d.tx >= latestTx);
        if (batchCurrentDatoms.length > 0) {
          const error = new Error(
            `Safety check failed: Attempted to delete ${batchCurrentDatoms.length} current datoms in final batch. This should never happen.`
          );
          this.logger?.error(
            "Safety check failed: current datoms in deletion batch",
            {
              event: "retention_policy_batch_safety_check_failed",
              policy: "destroy",
              batchNumber,
              latestTx,
              cutoffTx,
              currentDatomsCount: batchCurrentDatoms.length,
              error: error.message,
            }
          );
          throw error;
        }

        // Delete final batch
        const datomGroups = new Map<string, Datom[]>();
        for (const datom of currentBatch) {
          const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}|${datom.tx}|${datom.op}`;
          if (!datomGroups.has(key)) {
            datomGroups.set(key, []);
          }
          datomGroups.get(key)!.push(datom);
        }

        for (const [, groupDatoms] of datomGroups.entries()) {
          if (groupDatoms.length === 0) continue;
          const datom = groupDatoms[0]!;

          const deleteQuery: DatomsParams = {
            e: datom.e,
            a: datom.a,
            v: datom.v,
            tx: datom.tx,
            op: datom.op,
          };

          await this.sourceDb._destroy(deleteQuery);
        }

        deleted += currentBatch.length;

        this.logger?.debug("Final batch deleted", {
          event: "retention_policy_batch_deleted",
          policy: "destroy",
          batchNumber,
          totalBatches,
          batchSize: currentBatch.length,
          deletedSoFar: deleted,
        });
      }

      const duration = Date.now() - startTime;
      const result = {
        datomsProcessed: obsoleteDatoms.length,
        datomsDeleted: deleted,
        cutoffTx,
      };

      this.logger?.info("Retention policy execution completed", {
        event: "retention_policy_execution_complete",
        policy: "destroy",
        ...result,
        durationMs: duration,
        batchesProcessed: totalBatches,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorType =
        error instanceof Error ? error.constructor.name : typeof error;

      this.logger?.error("Retention policy execution failed", {
        event: "retention_policy_execution_failed",
        policy: "destroy",
        error: errorMessage,
        errorType,
        durationMs: duration,
        cutoffTx: 0,
      });

      return {
        datomsProcessed: 0,
        datomsDeleted: 0,
        cutoffTx: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Parse a simple cron expression to milliseconds
   * Supports basic patterns like "0 * * * *" (every hour)
   * This is a simplified parser - for production use a proper cron library
   */
  private parseCronExpression(cronExpr: string): number | null {
    // Simple parser for common patterns
    // Format: "minute hour day month weekday"
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) {
      return null;
    }

    const [minute, hour, day, month, weekday] = parts;

    // If minute is "0" and others are "*", it's hourly
    if (
      minute === "0" &&
      hour === "*" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    ) {
      return 60 * 60 * 1000; // 1 hour
    }

    // If minute is "0" and hour is "0", it's daily
    if (
      minute === "0" &&
      hour === "0" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    ) {
      return 24 * 60 * 60 * 1000; // 1 day
    }

    // Default: assume hourly if minute is specified
    if (
      minute !== "*" &&
      hour === "*" &&
      day === "*" &&
      month === "*" &&
      weekday === "*"
    ) {
      return 60 * 60 * 1000; // 1 hour
    }

    return null;
  }
}
