/**
 * Database module entry point
 */

// Core types
export type {
  Attribute,
  BatchQueryKey,
  ConnectionPoolConfig,
  ConnectionPoolStats,
  Datom,
  DatomInput,
  DatabaseHealth,
  DatabaseHealthStatus,
  EntityId,
  InterceptorError,
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

// Interceptor types
export type {
  AfterReadInterceptor,
  AfterWriteInterceptor,
  BeforeReadInterceptor,
  BeforeReadInterceptorResult,
  BeforeWriteInterceptor,
  BeforeWriteInterceptorResult,
  Interceptor,
  ReadContext,
  WriteContext,
} from "./interceptor-types.js";

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

// Error classes
export {
  ConnectionPoolExhaustedError,
  DatomDatabaseError,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionConflictError,
  TransactionError,
} from "./errors.js";

// Interceptor system
export { InterceptorEngine } from "./interceptor-engine.js";
export { InterceptorValidator } from "./interceptor-validator.js";
export type { InterceptorErrorWithName } from "./errors.js";
