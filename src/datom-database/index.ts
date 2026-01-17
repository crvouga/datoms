/**
 * Database module entry point
 */

// Core types
export type {
  Attribute,
  BatchQueryKey,
  ConnectionPoolConfig,
  ConnectionPoolStats,
  DatabaseHealth,
  DatabaseHealthStatus,
  Datom,
  DatomInput,
  EntityId,
  Logger,
  OptimisticLockOptions,
  QueryExplainResult,
  QueryOptions,
  Transaction,
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

export { InterceptorEngine } from "./interceptor/engine.js";
export { InterceptorValidator } from "./interceptor/validator.js";
