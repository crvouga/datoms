/**
 * Archive retention policy implementation
 * Archives obsolete historic datoms to another database before deleting them
 */

import { createLogger } from "../../../src/app/src/lib/logger.js";
import type { Datom } from "../../datoms.js";
import type { Logger } from "../../types.js";
import type { DatomDatabase } from "../datom-database.js";
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
 * Archive retention policy
 * Moves obsolete historic datoms to an archive database before deleting them from the source
 */
export class ArchiveRetentionPolicy implements RetentionPolicy {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly sourceDb: DatomDatabase,
    private readonly archiveDb: DatomDatabase,
    private readonly config: RetentionPolicyConfig,
    private readonly logger: Logger = createLogger()
  ) {
    if (config.retentionTxCount < 0) {
      throw new Error("retentionTxCount must be non-negative");
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
        policy: "archive",
      });
      return;
    }

    this.running = true;
    this.logger?.info("Starting archive retention policy", {
      event: "retention_policy_starting",
      policy: "archive",
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
          this.logger?.error("Archive retention policy execution failed", {
            event: "retention_policy_execution_error",
            policy: "archive",
            error: errorMessage,
            errorType: err instanceof Error ? err.constructor.name : typeof err,
          });
        });
      }, this.config.intervalMs);
    } else if (this.config.cronExpression) {
      // For cron expressions, we'll use a simple interval-based approach
      // In a production system, you'd want to use a proper cron library
      // For now, we'll parse simple cron expressions like "0 * * * *" (every hour)
      const intervalMs = this.parseCronExpression(this.config.cronExpression);
      if (intervalMs === null) {
        const error = new Error(
          `Invalid cron expression: ${this.config.cronExpression}`
        );
        this.logger?.error("Invalid cron expression", {
          event: "retention_policy_invalid_cron",
          policy: "archive",
          cronExpression: this.config.cronExpression,
          error: error.message,
        });
        throw error;
      }
      this.intervalId = setInterval(() => {
        this.execute().catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger?.error("Archive retention policy execution failed", {
            event: "retention_policy_execution_error",
            policy: "archive",
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
        policy: "archive",
      });
      return;
    }

    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.logger?.info("Stopped archive retention policy", {
      event: "retention_policy_stopped",
      policy: "archive",
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  async execute(): Promise<RetentionResult> {
    const startTime = Date.now();
    this.logger?.debug("Starting retention policy execution", {
      event: "retention_policy_execution_start",
      policy: "archive",
      retentionTxCount: this.config.retentionTxCount,
    });

    try {
      // Get latest transaction ID
      const latestTx = await this.sourceDb.getLatestTransaction();
      this.logger?.debug("Retrieved latest transaction", {
        event: "retention_policy_latest_tx_retrieved",
        policy: "archive",
        latestTx,
      });

      if (latestTx === 0) {
        this.logger?.info("No transactions found, skipping retention", {
          event: "retention_policy_no_transactions",
          policy: "archive",
        });
        return {
          datomsProcessed: 0,
          datomsDeleted: 0,
          datomsArchived: 0,
          cutoffTx: 0,
        };
      }

      // Calculate cutoff transaction ID
      const cutoffTx = Math.max(0, latestTx - this.config.retentionTxCount);
      this.logger?.debug("Calculated cutoff transaction", {
        event: "retention_policy_cutoff_calculated",
        policy: "archive",
        latestTx,
        retentionTxCount: this.config.retentionTxCount,
        cutoffTx,
      });

      if (cutoffTx === 0) {
        this.logger?.info("Cutoff transaction is 0, skipping retention", {
          event: "retention_policy_cutoff_zero",
          policy: "archive",
          latestTx,
          retentionTxCount: this.config.retentionTxCount,
        });
        return {
          datomsProcessed: 0,
          datomsDeleted: 0,
          datomsArchived: 0,
          cutoffTx: 0,
        };
      }

      // Get all datoms up to cutoff transaction using history view
      const allDatoms = await this.sourceDb
        .history()
        .datoms({ txMax: cutoffTx });

      // Compute obsolete datoms: group by (e, a, v), find latest tx per group, return non-latest
      const obsoleteDatoms = computeObsoleteDatoms(allDatoms);
      const batchSize = this.config.batchSize ?? 1000;

      this.logger?.info("Retrieved obsolete datoms", {
        event: "retention_policy_obsolete_datoms_retrieved",
        policy: "archive",
        cutoffTx,
        obsoleteDatomsCount: obsoleteDatoms.length,
        batchSize,
      });

      let archived = 0;
      let deleted = 0;
      const totalBatches = Math.ceil(obsoleteDatoms.length / batchSize);

      // Process in batches
      for (let i = 0; i < obsoleteDatoms.length; i += batchSize) {
        const batch = obsoleteDatoms.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;

        this.logger?.debug("Processing batch", {
          event: "retention_policy_batch_processing",
          policy: "archive",
          batchNumber,
          totalBatches,
          batchSize: batch.length,
          cutoffTx,
        });

        // Archive batch to archive database
        const archiveOps = batch.map((d) => ({
          e: d.e,
          a: d.a,
          v: d.v,
          op: d.op,
        }));
        await this.archiveDb.transact(archiveOps);
        archived += batch.length;

        this.logger?.debug("Batch archived", {
          event: "retention_policy_batch_archived",
          policy: "archive",
          batchNumber,
          totalBatches,
          batchSize: batch.length,
          archivedSoFar: archived,
        });

        // Delete batch from source database
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await this.sourceDb.deleteDatoms(batch);
        deleted += batch.length;

        this.logger?.debug("Batch deleted", {
          event: "retention_policy_batch_deleted",
          policy: "archive",
          batchNumber,
          totalBatches,
          batchSize: batch.length,
          deletedSoFar: deleted,
        });
      }

      const duration = Date.now() - startTime;
      const result = {
        datomsProcessed: obsoleteDatoms.length,
        datomsDeleted: deleted,
        datomsArchived: archived,
        cutoffTx,
      };

      this.logger?.info("Retention policy execution completed", {
        event: "retention_policy_execution_complete",
        policy: "archive",
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
        policy: "archive",
        error: errorMessage,
        errorType,
        durationMs: duration,
        cutoffTx: 0,
      });

      return {
        datomsProcessed: 0,
        datomsDeleted: 0,
        datomsArchived: 0,
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
