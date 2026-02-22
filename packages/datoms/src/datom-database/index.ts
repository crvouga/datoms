/**
 * Database module entry point
 */

// Core types from datoms.js
export type {Attribute, Datom, DatomInput, TransactionId, Value} from '../datoms.js';
// Core types from entity-id.js
export type {EntityId} from '../entity-id.js';
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
} from '../types.js';

// DatomDatabase classes
export type {DatomDatabase} from './datom-database.js';
export {
  FileSystemDatomDatabase,
  type FileSystemDatomDatabaseOptions,
} from './filesystem/filesystem-datom-database.js';
export {HttpClientDatomDatabase} from './http-client/http-client-datom-database.js';
export {HttpClientDatomDatabaseServerComponent} from './http-client/http-client-datom-database-server-component.js';
export {PostgreSQLDatomDatabase} from './postgres/postgres-datom-database.js';
export {DestroyRetentionPolicy} from './retention-policy/index.js';

// SQL connection adapter (types for adapter implementers)
export type {SQLDatabase, SQLDatabaseTransaction} from '../sql-database/sql-database.js';
export type {DatabaseRow, SQLParams} from '../sql-database/types.js';

// HTTP client (for app use)
export {FetchHttpClient, type HttpClient} from '../http-client/http-client.js';

// Datalog query types
export type {
  DatalogQuery,
  DatalogQueryFindVariable,
  DatalogQueryWhereClause as QueryClause,
} from '../datalog-query.js';

// Query result types
export type {QueryResult, QueryResultEnvelope} from './datom-database-view.js';

// WithResult type (for speculative transactions)
export type {WithResult} from './datom-database.js';

export {HookEngine} from './hook/hook.js';
export {HookValidator} from './hook/validator.js';
export type {
  AfterRead,
  AfterReadResult,
  AfterWrite,
  BeforeRead,
  BeforeReadResult,
  BeforeWrite,
  BeforeWriteResult,
  Hook,
  ReadContext,
  WriteContext,
} from './hook/hook.js';
