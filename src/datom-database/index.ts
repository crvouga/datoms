/**
 * Database module entry point
 */

// Core types
export type {
  Attribute,
  AttributeDefinition,
  BatchQueryKey,
  ConnectionPoolConfig,
  ConnectionPoolStats,
  Datom,
  DatomInput,
  DatabaseHealth,
  DatabaseHealthStatus,
  EntityId,
  Logger,
  Migration,
  MigrationDatabase,
  MigrationState,
  OptimisticLockOptions,
  QueryExplainResult,
  QueryOptions,
  SchemaExport,
  TransactionId,
  TransactionIsolationLevel,
  TransactionOptions,
  Value,
} from "../types.js";

// DatomDatabase classes
export { InMemoryDatomDatabase } from "./datom-database-in-memory.js";
export { PostgreSQLDatomDatabase } from "./datom-database-postgres.js";
export { SQLiteDatomDatabase } from "./datom-database-sqlite.js";
export { DatomDatabase } from "./datom-database.js";

// SQL connection adapter
export type { SQLDatabase } from "../sql-database/sql-database.js";

// Datalog query types
export {
  type DatalogQuery,
  type QueryClause,
  type QueryResult,
} from "../datalog/datalog.js";

// WithResult type (for speculative transactions)
export type { WithResult } from "./datom-database.js";

// Migration registry
export { MigrationRegistry } from "./migrations/migration-registry.js";

// Error classes
export {
  CardinalityError,
  ConnectionPoolExhaustedError,
  DatomDatabaseError,
  DatomTypeError,
  MigrationError,
  MigrationRollbackError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionConflictError,
  UniqueConstraintError,
} from "./errors.js";
