/**
 * Observability wrapper for DatomDatabase
 * Provides event system, statistics, health checks, and metrics tracking
 */

import type { DatomDatabase, TransactOperations } from "../datom-database.js";
import type {
  DatabaseEvent,
  DatabaseEventListener,
  DatabaseHealth,
  DatabaseStats,
  Datom,
  Logger,
  QueryOptions,
  TransactionId,
} from "../../types.js";
import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import {
  exportDatoms as exportDatomsImpl,
  importDatoms as importDatomsImpl,
} from "../backup/backup.js";

/**
 * Observable database wrapper that adds observability features to a DatomDatabase
 */
export class ObservableDatabase {
  private eventListeners: Map<
    DatabaseEvent["type"],
    Set<DatabaseEventListener>
  > = new Map();
  private logger?: Logger;
  private queryCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionCount: number = 0;
  private transactionTimeSum: number = 0;

  constructor(private db: DatomDatabase) {}

  /**
   * Set an optional logger for structured logging
   * Compatible with common logging libraries (Pino, Winston, etc.)
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Get the underlying database instance
   */
  getDatabase(): DatomDatabase {
    return this.db;
  }

  /**
   * Execute a transaction and automatically emit transaction events
   * This wraps the underlying database's transact method to add observability
   */
  async transact(
    ops: TransactOperations,
    metadata?: Record<string, unknown>
  ): Promise<TransactionId> {
    const addedCount = ops.filter((op) => op.op === "added").length;
    const retractedCount = ops.filter((op) => op.op === "retracted").length;
    const startTime = Date.now();

    try {
      const txId = await this.db.transact(ops, metadata);
      const duration = (Date.now() - startTime) / 1000;

      // Track transaction metrics
      this.transactionCount++;
      this.transactionTimeSum += duration * 1000; // Store in milliseconds for consistency

      // Emit transaction event
      await this.emitEvent({
        type: "transaction",
        txId,
        addedCount,
        retractedCount,
        metadata,
      });

      return txId;
    } catch (error) {
      // Emit error event
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: {
          operation: "transact",
          addedCount,
          retractedCount,
        },
      });
      throw error;
    }
  }

  /**
   * Query datoms and automatically emit query events
   * This wraps the underlying database's datoms method to add observability
   */
  async datoms(options: QueryOptions): Promise<Datom[]> {
    const startTime = Date.now();
    try {
      const results = await this.db.datoms(options);
      const duration = (Date.now() - startTime) / 1000;

      // Track query metrics
      this.queryCount++;
      this.queryTimeSum += duration * 1000; // Store in milliseconds for consistency

      // Emit query event
      await this.emitEvent({
        type: "query",
        options,
        resultCount: results.length,
        duration,
      });

      return results;
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;

      // Emit error event
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: {
          operation: "datoms",
          options,
          duration,
        },
      });
      throw error;
    }
  }

  /**
   * Execute a datalog query and automatically emit query events
   * This wraps the underlying database's query method to add observability
   */
  async query(query: DatalogQuery): Promise<QueryResult> {
    const startTime = Date.now();
    try {
      const results = await this.db.query(query);
      const duration = (Date.now() - startTime) / 1000;

      // Track query metrics
      this.queryCount++;
      this.queryTimeSum += duration * 1000; // Store in milliseconds for consistency

      // Emit query event
      // Note: QueryOptions doesn't include query, so we pass empty options for datalog queries
      await this.emitEvent({
        type: "query",
        options: {},
        resultCount: results.length,
        duration,
      });

      return results;
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;

      // Emit error event
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: {
          operation: "query",
          query,
          duration,
        },
      });
      throw error;
    }
  }

  /**
   * Migrate the database schema and automatically emit migration events
   * This wraps the underlying database's migrate method to add observability
   */
  async migrate(targetVersion: number): Promise<void> {
    try {
      await this.db.migrate(targetVersion);

      // Emit migration event
      await this.emitEvent({
        type: "migration",
        version: targetVersion,
        success: true,
      });
    } catch (error) {
      // Emit error event
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: {
          operation: "migrate",
          targetVersion,
        },
      });

      // Also emit migration event with success=false
      await this.emitEvent({
        type: "migration",
        version: targetVersion,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });

      throw error;
    }
  }

  /**
   * Export datoms from the database and automatically emit backup events
   * This wraps the backup module's exportDatoms function to add observability
   */
  async *exportDatoms(options?: QueryOptions): AsyncIterable<Datom> {
    let datomCount = 0;
    try {
      for await (const datom of exportDatomsImpl(this.db, options)) {
        datomCount++;
        yield datom;
      }

      // Emit backup event after successful export
      await this.emitEvent({
        type: "backup",
        datomCount,
        success: true,
      });
    } catch (error) {
      // Emit error event
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: {
          operation: "export",
          datomCount,
        },
      });

      // Also emit backup event with success=false
      await this.emitEvent({
        type: "backup",
        datomCount,
        success: false,
      });

      throw error;
    }
  }

  /**
   * Import datoms into the database and automatically emit restore events
   * This wraps the backup module's importDatoms function to add observability
   */
  async importDatoms(
    source: AsyncIterable<Datom>,
    options?: { batchSize?: number; validate?: boolean }
  ): Promise<number> {
    try {
      const datomCount = await importDatomsImpl(this.db, source, options);

      // Emit restore event after successful import
      await this.emitEvent({
        type: "restore",
        datomCount,
        success: true,
      });

      return datomCount;
    } catch (error) {
      // Emit error event
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: {
          operation: "import",
        },
      });

      // Also emit restore event with success=false
      await this.emitEvent({
        type: "restore",
        datomCount: 0,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });

      throw error;
    }
  }

  /**
   * Register an event listener for database events
   */
  on(
    eventType: DatabaseEvent["type"],
    listener: DatabaseEventListener
  ): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    this.eventListeners.get(eventType)!.add(listener);
    // Return unsubscribe function
    return () => {
      this.eventListeners.get(eventType)?.delete(listener);
    };
  }

  /**
   * Emit an event to all registered listeners
   */
  async emitEvent(event: DatabaseEvent): Promise<void> {
    // Log event if logger is configured
    if (this.logger) {
      const logLevel =
        event.type === "error"
          ? "error"
          : event.type === "query"
            ? "debug"
            : "info";
      const logMeta: Record<string, unknown> = { eventType: event.type };

      if (event.type === "transaction") {
        logMeta.txId = event.txId;
        logMeta.addedCount = event.addedCount;
        logMeta.retractedCount = event.retractedCount;
      } else if (event.type === "query") {
        logMeta.resultCount = event.resultCount;
        logMeta.duration = event.duration;
      } else if (event.type === "error") {
        logMeta.error = event.error.message;
        logMeta.errorStack = event.error.stack;
      } else if (event.type === "migration") {
        logMeta.version = event.version;
        logMeta.success = event.success;
      } else if (event.type === "backup" || event.type === "restore") {
        logMeta.datomCount = event.datomCount;
        logMeta.success = event.success;
      }

      if (logLevel === "error") {
        this.logger.error(`Database event: ${event.type}`, logMeta);
      } else if (logLevel === "debug") {
        this.logger.debug(`Database event: ${event.type}`, logMeta);
      } else {
        this.logger.info(`Database event: ${event.type}`, logMeta);
      }
    }

    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      // Use Promise.allSettled to ensure all listeners are called even if some fail
      const results = await Promise.allSettled(
        Array.from(listeners).map(async (listener) => {
          return await listener(event);
        })
      );

      // Emit error events for failed listeners, but don't let that break the flow
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "rejected") {
          try {
            await this.emitEvent({
              type: "error",
              error:
                result.reason instanceof Error
                  ? result.reason
                  : new Error(String(result.reason)),
              context: {
                eventType: event.type,
                listenerError: true,
              },
            });
          } catch (emitError) {
            // Ignore errors in error event emission to prevent infinite loops
            const errorMsg = `Failed to emit error event for listener failure: ${emitError}`;
            if (this.logger) {
              this.logger.error(errorMsg, { error: emitError });
            } else {
              console.error(errorMsg, emitError);
            }
          }
        }
      }
    }
  }

  /**
   * Get database statistics for observability
   */
  async getStats(): Promise<DatabaseStats> {
    const latestTx = await this.db.getLatestTransaction();

    // Get schema attribute count from exportSchema
    let schemaAttributeCount = 0;
    try {
      const schemaExport = await this.db.exportSchema();
      schemaAttributeCount = schemaExport.attributes.length;
    } catch {
      // If exportSchema fails, schemaAttributeCount remains 0
    }

    const stats: DatabaseStats = {
      totalDatoms: 0,
      totalEntities: 0,
      totalTransactions: latestTx,
      latestTransaction: latestTx,
      schemaAttributeCount,
    };

    // Try to get more detailed stats (implementations can override)
    const detailedStats = await this.getDetailedStats();
    Object.assign(stats, detailedStats);

    return stats;
  }

  /**
   * Hook for implementations to provide detailed statistics
   */
  protected async getDetailedStats(): Promise<
    Partial<
      Pick<
        DatabaseStats,
        "totalDatoms" | "totalEntities" | "queryMetrics" | "transactionMetrics"
      >
    >
  > {
    const stats: Partial<
      Pick<DatabaseStats, "queryMetrics" | "transactionMetrics">
    > = {};

    // Add query metrics if available
    if (this.queryCount > 0) {
      stats.queryMetrics = {
        totalQueries: this.queryCount,
        averageQueryTime: this.queryTimeSum / this.queryCount / 1000, // Convert to seconds
      };
    }

    // Add transaction metrics if available
    if (this.transactionCount > 0) {
      stats.transactionMetrics = {
        averageTransactionTime:
          this.transactionTimeSum / this.transactionCount / 1000, // Convert to seconds
      };
    }

    return stats;
  }

  /**
   * Perform a health check on the database
   */
  async healthCheck(): Promise<DatabaseHealth> {
    const timestamp = new Date().toISOString();
    const errors: string[] = [];
    const warnings: string[] = [];
    let overallStatus: DatabaseHealth["status"] = "healthy";

    // Check connection pool health
    const connectionPool = await this.getConnectionHealth();
    if (connectionPool) {
      const poolHealthy =
        connectionPool.waitingRequests === 0 &&
        connectionPool.activeConnections <
          connectionPool.totalConnections * 0.9; // Less than 90% capacity

      if (!poolHealthy) {
        warnings.push(
          `Connection pool at ${Math.round(
            (connectionPool.activeConnections /
              connectionPool.totalConnections) *
              100
          )}% capacity`
        );
        if (connectionPool.waitingRequests > 0) {
          overallStatus = "degraded";
          errors.push(
            `${connectionPool.waitingRequests} requests waiting for connections`
          );
        }
      }
    }

    // Check query performance
    const stats = await this.getStats();
    const queryPerformance = stats.queryMetrics
      ? {
          healthy: true,
          averageQueryTime: stats.queryMetrics.averageQueryTime,
          slowQueries: 0,
          details: `Average query time: ${stats.queryMetrics.averageQueryTime?.toFixed(
            3
          )}s`,
        }
      : undefined;

    if (
      queryPerformance &&
      queryPerformance.averageQueryTime !== undefined &&
      queryPerformance.averageQueryTime > 1.0
    ) {
      warnings.push(
        `Average query time is ${queryPerformance.averageQueryTime.toFixed(
          3
        )}s (consider optimization)`
      );
      if (queryPerformance.averageQueryTime > 5.0) {
        overallStatus = "degraded";
      }
    }

    // Check transaction health
    const transactionHealth = stats.transactionMetrics
      ? {
          healthy: true,
          averageTransactionTime:
            stats.transactionMetrics.averageTransactionTime,
          failedTransactions: 0,
          details: `Average transaction time: ${stats.transactionMetrics.averageTransactionTime?.toFixed(
            3
          )}s`,
        }
      : undefined;

    if (
      transactionHealth &&
      transactionHealth.averageTransactionTime !== undefined &&
      transactionHealth.averageTransactionTime > 2.0
    ) {
      warnings.push(
        `Average transaction time is ${transactionHealth.averageTransactionTime.toFixed(
          3
        )}s (consider optimization)`
      );
      if (transactionHealth.averageTransactionTime > 10.0) {
        overallStatus = "degraded";
      }
    }

    // If we have errors, mark as unhealthy
    if (errors.length > 0) {
      overallStatus = "unhealthy";
    } else if (warnings.length > 0 && overallStatus === "healthy") {
      overallStatus = "degraded";
    }

    return {
      status: overallStatus,
      timestamp,
      connectionPool: connectionPool
        ? {
            healthy:
              connectionPool.waitingRequests === 0 &&
              connectionPool.activeConnections <
                connectionPool.totalConnections * 0.9,
            activeConnections: connectionPool.activeConnections,
            idleConnections: connectionPool.idleConnections,
            waitingRequests: connectionPool.waitingRequests,
            details: `Active: ${connectionPool.activeConnections}/${connectionPool.totalConnections}, Waiting: ${connectionPool.waitingRequests}`,
          }
        : undefined,
      queryPerformance,
      transactionHealth,
      details:
        overallStatus === "healthy"
          ? "All systems operational"
          : `${errors.length} error(s), ${warnings.length} warning(s)`,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Get connection health information
   */
  protected async getConnectionHealth(): Promise<
    import("../../types.js").ConnectionPoolStats | undefined
  > {
    // Default: no connection pool (in-memory implementations)
    // SQL implementations should override this
    return undefined;
  }

  /**
   * Record query metrics for observability
   */
  async recordQueryMetrics(_duration: number): Promise<void> {
    // Default: no-op. Implementations should override to track metrics thread-safely.
  }

  /**
   * Record transaction metrics for observability
   */
  async recordTransactionMetrics(_duration: number): Promise<void> {
    // Default: no-op. Implementations should override to track metrics thread-safely.
  }
}
