/**
 * SQL connection adapter interface for SQL database implementations
 */

import type { ConnectionPoolStats } from "../types.js";
import type { DatabaseRow, SQLParams } from "./types.js";

/**
 * SQL connection interface that abstracts different SQL libraries
 *
 * **Connection Pooling:**
 * - Implementations using connection pools should expose `getPoolStats()` for monitoring
 * - Connection pool configuration is implementation-specific (see `ConnectionPoolConfig` type)
 * - Single-connection implementations can omit `getPoolStats()`
 */
export interface SQLDatabase {
  query(sql: string, params?: SQLParams): Promise<DatabaseRow[]>;
  execute(sql: string, params?: SQLParams): Promise<void>;
  beginTransaction?(): Promise<void>;
  commitTransaction?(): Promise<void>;
  rollbackTransaction?(): Promise<void>;
  close?(): Promise<void>;
  /**
   * Get connection pool statistics (optional, for implementations with connection pooling)
   * @returns Pool statistics if pooling is used, undefined otherwise
   * @example
   * const stats = await sqlDb.getPoolStats?.();
   * if (stats) {
   *   console.log(`Active connections: ${stats.activeConnections}`);
   *   console.log(`Idle connections: ${stats.idleConnections}`);
   * }
   */
  getPoolStats?(): Promise<ConnectionPoolStats>;
}
