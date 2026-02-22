/**
 * Destroy retention policy implementation
 * Permanently deletes historic datoms, keeping only the latest N historical datoms per (entity, attribute) pair
 *
 * Safety guarantees:
 * - Never deletes current datoms (always keeps at least retentionTxCount datoms per (e, a) pair)
 * - Requires retentionTxCount >= 1 to prevent deleting all history
 * - Only processes (e, a) pairs that have more than N historical datoms
 * - Uses database-native operations to avoid loading data into memory
 */

import type {Logger} from '../../types.js';
import type {DatomDatabase} from '../datom-database.js';
import type {RetentionPolicy} from './retention-policy.js';

export type DestroyRetentionPolicyConfig = {
  retentionCount: number;
  intervalMs: number;
};

/**
 * Destroy retention policy
 * Permanently deletes historic datoms, keeping only the latest N historical datoms per (entity, attribute) pair
 * Uses database-native operations to efficiently process retention without loading data into memory
 */
export class DestroyRetentionPolicy implements RetentionPolicy {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private sourceDb: DatomDatabase;
  private config: DestroyRetentionPolicyConfig;
  private logger: Logger;

  constructor({
    sourceDb,
    config,
    logger,
  }: {
    sourceDb: DatomDatabase;
    config: DestroyRetentionPolicyConfig;
    logger: Logger;
  }) {
    this.sourceDb = sourceDb;
    this.config = config;
    this.logger = logger;
    // Ensure we always keep at least 1 datom per (entity, attribute) pair
    // This prevents accidentally deleting all history
    if (config.retentionCount < 1) {
      throw new Error(
        'retentionCount must be at least 1 to ensure at least one historical datom is kept per (entity, attribute) pair',
      );
    }
    if (!config.intervalMs) {
      throw new Error('intervalMs must be provided');
    }
  }

  start(): void {
    if (this.running) {
      this.logger?.warn('Retention policy already running', {
        event: 'retention_policy_already_running',
        policy: 'destroy',
      });
      return;
    }

    this.running = true;
    this.logger?.info('Starting destroy retention policy', {
      event: 'retention_policy_starting',
      policy: 'destroy',
      retentionCount: this.config.retentionCount,
      intervalMs: this.config.intervalMs,
    });

    if (this.config.intervalMs) {
      // Use interval-based scheduling
      this.intervalId = setInterval(() => {
        this.execute().catch(err => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger?.error('Destroy retention policy execution failed', {
            event: 'retention_policy_execution_error',
            policy: 'destroy',
            error: errorMessage,
            errorType: err instanceof Error ? err.constructor.name : typeof err,
          });
        });
      }, this.config.intervalMs);
    }
  }

  stop(): void {
    if (!this.running) {
      this.logger?.warn('Retention policy not running', {
        event: 'retention_policy_not_running',
        policy: 'destroy',
      });
      return;
    }

    this.running = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.logger?.info('Stopped destroy retention policy', {
      event: 'retention_policy_stopped',
      policy: 'destroy',
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  async execute(): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    this.logger?.debug('Starting retention policy execution', {
      event: 'retention_policy_execution_start',
      policy: 'destroy',
      retentionCount: this.config.retentionCount,
    });

    this.logger?.info('Starting per-entity-attribute retention cleanup', {
      event: 'retention_policy_deletion_start',
      policy: 'destroy',
      retentionCount: this.config.retentionCount,
    });

    try {
      const deleted = await this.sourceDb._destroy({
        retentionCount: this.config.retentionCount,
      });

      const duration = Date.now() - startTime;
      const result = {
        datomsProcessed: deleted,
        datomsDeleted: deleted,
      };

      this.logger?.info('Retention policy execution completed', {
        event: 'retention_policy_execution_complete',
        policy: 'destroy',
        ...result,
        durationMs: duration,
        retentionCount: this.config.retentionCount,
      });

      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const result = {
        datomsProcessed: 0,
        datomsDeleted: 0,
        error: errorMessage,
      };

      this.logger?.error('Destroy retention policy execution failed', {
        event: 'retention_policy_execution_error',
        policy: 'destroy',
        error: errorMessage,
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        durationMs: duration,
        retentionCount: this.config.retentionCount,
      });

      return result;
    }
  }
}
