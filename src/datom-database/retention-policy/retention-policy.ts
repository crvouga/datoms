/**
 * Retention policy interface for managing historic datom cleanup
 * Lifecycle methods are managed by the user, not the database
 */

import type { RetentionResult } from "./types.js";

/**
 * Retention policy interface
 * Implementations handle archiving or destroying obsolete historic datoms
 */
export interface RetentionPolicy {
  /**
   * Start the retention policy interval
   * Begins periodic execution based on configured interval or cron expression
   */
  start(): void;

  /**
   * Stop the retention policy interval
   * Stops periodic execution and cleans up resources
   */
  stop(): void;

  /**
   * Check if the retention policy is currently running
   * @returns true if the policy is active, false otherwise
   */
  isRunning(): boolean;

  /**
   * Execute the retention policy once
   * Useful for manual execution or testing
   * @returns Result of the retention operation
   */
  execute(): Promise<RetentionResult>;
}
