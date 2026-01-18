/**
 * Types and configuration for retention policies
 */

import type { TransactionId } from "../../datoms.js";

/**
 * Configuration for retention policies
 */
export interface RetentionPolicyConfig {
  /** Number of transactions to retain (keep last N transactions) */
  retentionTxCount: number;
  /** Interval in milliseconds for periodic execution (optional if using cron) */
  intervalMs?: number;
  /** Cron expression for scheduling (optional if using intervalMs) */
  cronExpression?: string;
  /** Batch size for processing datoms (default: 1000) */
  batchSize?: number;
}

/**
 * Result of a retention policy execution
 */
export interface RetentionResult {
  /** Number of datoms processed */
  datomsProcessed: number;
  /** Number of datoms deleted */
  datomsDeleted: number;
  /** Number of datoms archived (if applicable) */
  datomsArchived?: number;
  /** Cutoff transaction ID used */
  cutoffTx: TransactionId;
  /** Error message if execution failed */
  error?: string;
}
