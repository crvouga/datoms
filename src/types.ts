/**
 * Core types for the datoms database
 */

/**
 * A unique identifier for an entity
 */
export type EntityId = number | string;

/**
 * An attribute name (e.g., "name", "age", "email")
 */
export type Attribute = string;

/**
 * A value that can be stored in a datom.
 *
 * **Type Safety:** This is a strict union type of allowed value types.
 * All values must be one of these types - no other types are permitted.
 *
 * **Supported Types:**
 * - Primitives: `string`, `number`, `boolean`
 * - Temporal: `Date` objects
 * - Nullability: `null`, `undefined` (for optional attributes)
 * - References: `EntityId` (number | string) for entity relationships
 *
 * **Note:** `EntityId` is included here to allow referencing other entities as values.
 * Since `EntityId` can be `number | string`, numeric entity IDs overlap with
 * the `number` type, which is intentional and handled correctly by TypeScript.
 *
 * @example
 * // Valid values:
 * [1, "name", "Alice"]                    // string
 * [1, "age", 30]                          // number
 * [1, "active", true]                      // boolean
 * [1, "createdAt", new Date()]            // Date
 * [1, "middleName", null]                 // null
 * [1, "optional", undefined]              // undefined
 * [1, "parent", 42]                       // EntityId (number)
 * [1, "owner", "user-123"]               // EntityId (string)
 */
export type Value =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | EntityId;

/**
 * A transaction ID (monotonically increasing)
 */
export type TransactionId = number;

/**
 * A datom represents a fact: { e: entity, a: attribute, v: value, tx: transaction, op: "add" | "retract" }
 * This is the fundamental unit of data in a datalog database
 */
export type Datom = {
  /** The entity this datom describes */
  e: EntityId;
  /** The attribute being asserted */
  a: Attribute;
  /** The value of the attribute */
  v: Value;
  /** The transaction ID when this datom was add */
  tx: TransactionId;
  /** The operation type (add or retract) */
  op: "add" | "retract";
};

/**
 * A partial datom for adding/retracting facts (without tx and add)
 * Tuple format: [entity, attribute, value]
 * This is more efficient and aligns with the fixed EAV structure
 */
export type DatomInput = {
  /** The entity this datom describes */
  e: EntityId;
  /** The attribute being asserted */
  a: Attribute;
  /** The value of the attribute */
  v: Value;
};

/**
 * Options for querying datoms
 */
export interface QueryOptions {
  /** Filter by entity ID */
  e?: EntityId;
  /** Filter by attribute */
  a?: Attribute;
  /** Filter by value */
  v?: Value;
  /** Filter by transaction ID */
  tx?: TransactionId;
  /** Filter by operation type */
  op?: "add" | "retract";
  /** Limit the number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Hint for which index to use (backend-specific, may be ignored) */
  indexHint?: string | string[];
  /** Maximum query execution time in milliseconds */
  timeoutMs?: number;
  /** Maximum number of results allowed (throws QueryResultSizeError if exceeded) */
  maxResultSize?: number;
}

/**
 * Database statistics for observability
 */
export interface DatabaseStats {
  /** Total number of datoms in the database */
  totalDatoms: number;
  /** Total number of entities */
  totalEntities: number;
  /** Total number of transactions */
  totalTransactions: number;
  /** Latest transaction ID */
  latestTransaction: TransactionId;
  /** Query performance metrics (if available) */
  queryMetrics?: {
    averageQueryTime?: number;
    totalQueries?: number;
  };
  /** Transaction throughput metrics (if available) */
  transactionMetrics?: {
    transactionsPerSecond?: number;
    averageTransactionTime?: number;
  };
}

/**
 * Event types emitted by the database
 */
export type DatabaseEventType =
  | "transaction"
  | "error"
  | "query"
  | "migration"
  | "backup"
  | "restore";

/**
 * Event payload for transaction events
 */
export interface TransactionEvent {
  type: "transaction";
  txId: TransactionId;
  addCount: number;
  retractCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * Event payload for error events
 */
export interface ErrorEvent {
  type: "error";
  error: Error;
  context?: Record<string, unknown>;
}

/**
 * Event payload for query events
 */
export interface QueryEvent {
  type: "query";
  options: QueryOptions;
  resultCount: number;
  duration?: number;
}

/**
 * Event payload for migration events
 */
export interface MigrationEvent {
  type: "migration";
  version: number;
  success: boolean;
  error?: Error;
}

/**
 * Event payload for backup/restore events
 */
export interface BackupEvent {
  type: "backup" | "restore";
  datomCount: number;
  success: boolean;
  error?: Error;
}

/**
 * Union type for all database events
 */
export type DatabaseEvent =
  | TransactionEvent
  | ErrorEvent
  | QueryEvent
  | MigrationEvent
  | BackupEvent;

/**
 * Event listener callback type
 */
export type DatabaseEventListener = (
  event: DatabaseEvent
) => void | Promise<void>;

/**
 * Transaction isolation levels following SQL standard
 * Controls how concurrent transactions interact with each other
 */
export type TransactionIsolationLevel =
  | "READ_UNCOMMITTED" // Lowest isolation, allows dirty reads
  | "READ_COMMITTED" // Default: prevents dirty reads, allows non-repeatable reads
  | "REPEATABLE_READ" // Prevents non-repeatable reads, allows phantom reads
  | "SERIALIZABLE"; // Highest isolation, prevents all anomalies

/**
 * Options for optimistic locking
 */
export interface OptimisticLockOptions {
  /** Expected transaction ID (transaction will fail if current txId doesn't match) */
  expectedTxId?: TransactionId;
  /** Retry configuration for conflicts */
  retry?: {
    /** Maximum number of retries */
    maxRetries: number;
    /** Delay between retries in milliseconds */
    delayMs?: number;
  };
}

/**
 * Options for transaction execution
 * Extends optimistic locking options with additional transaction controls
 */
export interface TransactionOptions extends OptimisticLockOptions {
  /** Transaction isolation level (default: READ_COMMITTED) */
  isolationLevel?: TransactionIsolationLevel;
  /** Per-transaction timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result of query explanation/analysis for optimization hints
 */
export interface QueryExplainResult {
  /** Estimated number of rows that will be returned */
  estimatedRows?: number;
  /** Query cost estimate (backend-specific units) */
  estimatedCost?: number;
  /** Indexes that will be used for this query */
  indexesUsed?: string[];
  /** Type of scan that will be performed */
  scanType?: "index" | "full-table" | "index-only" | "unknown";
  /** Optimization warnings or suggestions */
  warnings?: string[];
  /** Backend-specific raw explain output (e.g., SQL EXPLAIN result) */
  raw?: unknown;
}

/**
 * Configuration for connection pooling
 * Used by SQL database implementations to configure connection pools
 */
export interface ConnectionPoolConfig {
  /** Maximum number of connections in the pool */
  maxConnections?: number;
  /** Minimum number of connections to maintain */
  minConnections?: number;
  /** Time in milliseconds before idle connections are closed */
  idleTimeout?: number;
  /** Time in milliseconds to wait for a connection before timing out */
  connectionTimeout?: number;
  /** Maximum lifetime of a connection in milliseconds before it's recycled */
  maxLifetime?: number;
}

/**
 * Statistics about a connection pool
 * Used for monitoring and observability
 */
export interface ConnectionPoolStats {
  /** Number of active connections currently in use */
  activeConnections: number;
  /** Number of idle connections available */
  idleConnections: number;
  /** Total number of connections in the pool */
  totalConnections: number;
  /** Number of requests waiting for a connection */
  waitingRequests: number;
}

/**
 * Database health status
 * Used for monitoring and operational health checks
 */
export type DatabaseHealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Database health check result
 * Provides detailed information about database operational status
 */
export interface DatabaseHealth {
  /** Overall health status */
  status: DatabaseHealthStatus;
  /** Timestamp when health check was performed */
  timestamp: string;
  /** Connection pool health (if applicable) */
  connectionPool?: {
    healthy: boolean;
    activeConnections: number;
    idleConnections: number;
    waitingRequests: number;
    details?: string;
  };
  /** Query performance health */
  queryPerformance?: {
    healthy: boolean;
    averageQueryTime?: number;
    slowQueries?: number;
    details?: string;
  };
  /** Transaction health */
  transactionHealth?: {
    healthy: boolean;
    averageTransactionTime?: number;
    failedTransactions?: number;
    details?: string;
  };
  /** Additional health details */
  details?: string;
  /** Health check errors or warnings */
  errors?: string[];
  warnings?: string[];
}

/**
 * Minimal database interface for migrations
 * Provides the operations that migrations typically need
 */
export interface MigrationDatabase {
  /** Migrate to a specific schema version */
  migrate(targetVersion: number): Promise<void>;
}

/**
 * Migration interface for up/down migrations
 * Migrations are versioned and can be rolled back
 */
export interface Migration {
  /** Migration version number (must be unique and sequential) */
  version: number;
  /** Migration name/description */
  name: string;
  /** Up migration: applies the migration */
  up(db: MigrationDatabase): Promise<void>;
  /** Down migration: rolls back the migration */
  down(db: MigrationDatabase): Promise<void>;
}

/**
 * Migration state stored in database
 */
export interface MigrationState {
  /** Migration version */
  version: number;
  /** Migration name */
  name: string;
  /** When migration was applied */
  appliedAt: string;
  /** Whether migration was rolled back */
  rolledBack: boolean;
  /** When migration was rolled back (if applicable) */
  rolledBackAt?: string;
}

/**
 * Logger interface for structured logging
 * Compatible with common logging libraries (Pino, Winston, etc.)
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Batch query key for type-safe entity-attribute pair access
 * Used internally for batch query result mapping
 */
export type BatchQueryKey = string;
