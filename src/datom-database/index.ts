/**
 * Database module entry point
 */

// Core types from datoms.js
export type {
  Attribute,
  Datom,
  DatomInput,
  TransactionId,
  Value,
} from "../datoms.js";
// Core types from entity-id.js
export type { EntityId } from "../entity-id.js";
// Types from types.js
export type {
  BatchQueryKey,
  ConnectionPoolConfig,
  ConnectionPoolStats,
  DatabaseHealth,
  DatabaseHealthStatus,
  Logger,
  OptimisticLockOptions,
  QueryExplainResult,
  Transaction,
  TransactionIsolationLevel,
  TransactionOptions,
} from "../types.js";

// DatomDatabase classes
export { InMemoryDatomDatabase } from "./in-memory/in-memory-datom-database.js";
export {
  PostgreSQLDatomDatabase,
  datalogToPostgresSQL,
} from "./postgres/postgres-datom-database.js";
export { SQLiteDatomDatabase } from "./sqlite/sqlite-datom-database.js";
export type { DatomDatabase } from "./datom-database.js";

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

export { HookEngine } from "./hook/hook.js";
export { HookValidator } from "./hook/validator.js";
