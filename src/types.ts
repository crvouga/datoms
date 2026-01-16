/**
 * Core types for the datoms database
 */

/**
 * A unique identifier for an entity
 *
 * **Note on symbol support:**
 * Symbols are supported but require special serialization when persisting to SQL/JSON.
 * For persistent databases with sync/replication, prefer `number` or `string` EntityIds.
 * Symbols are serialized as `__SYMBOL__${String(symbol)}` in SQL implementations.
 */
export type EntityId = number | string | symbol;

/**
 * An attribute name (e.g., "name", "age", "email")
 */
export type Attribute = string | symbol;

/**
 * A value that can be stored in a datom
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
 * A datom represents a fact: (entity, attribute, value, transaction)
 * This is the fundamental unit of data in a datalog database
 */
export interface Datom {
  /** The entity this datom describes */
  entity: EntityId;
  /** The attribute being asserted */
  attribute: Attribute;
  /** The value of the attribute */
  value: Value;
  /** The transaction ID when this datom was added */
  tx: TransactionId;
  /** Whether this datom is an addition (true) or retraction (false) */
  added: boolean;
}

/**
 * A partial datom for adding/retracting facts (without tx and added)
 * Tuple format: [entity, attribute, value]
 * This is more efficient and aligns with the fixed EAV structure
 */
export type DatomInput = [EntityId, Attribute, Value];

/**
 * Constants for tuple indices (for better readability when needed)
 */
export const DATOM_ENTITY = 0;
export const DATOM_ATTRIBUTE = 1;
export const DATOM_VALUE = 2;

/**
 * Options for querying datoms
 */
export interface QueryOptions {
  /** Filter by entity ID */
  entity?: EntityId;
  /** Filter by attribute */
  attribute?: Attribute;
  /** Filter by value */
  value?: Value;
  /** Filter by transaction ID */
  tx?: TransactionId;
  /** Only return added datoms (default: true) */
  added?: boolean;
  /** Limit the number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Query database state as it existed at this transaction ID (time-travel query) */
  asOf?: TransactionId;
  /** Query full history of changes (all datoms matching filters, not just latest) */
  history?: boolean;
  /** Hint for which index to use (backend-specific, may be ignored) */
  indexHint?: string | string[];
}

/**
 * Definition for an attribute schema
 */
export interface AttributeDefinition {
  /** Attribute name */
  name: string;
  /** Whether the attribute can have one or many values */
  cardinality: "one" | "many";
  /** Whether the attribute value must be unique across all entities */
  unique?: boolean;
  /** Whether to create an index for this attribute */
  indexed?: boolean;
  /** Optional type constraint for attribute values. If specified, values must match this type. Use null to allow any type. */
  type?: "string" | "number" | "boolean" | "date" | "ref" | null;
}

/**
 * Schema for the database
 */
export interface Schema {
  /** Map of attribute names to their definitions */
  attributes: Map<string, AttributeDefinition>;
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
  /** Number of attributes defined in schema */
  schemaAttributeCount: number;
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
  addedCount: number;
  retractedCount: number;
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
 * Versioned schema export format
 * Includes metadata for schema evolution and migration tracking
 */
export interface SchemaExport {
  /** Schema format version (for compatibility checking) */
  version: number;
  /** Application schema version (from getSchemaVersion()) */
  schemaVersion: number;
  /** ISO timestamp when schema was exported */
  exportedAt: string;
  /** Array of attribute definitions */
  attributes: AttributeDefinition[];
}
