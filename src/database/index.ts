/**
 * Database module entry point
 */

// Core types
export type {
  EntityId,
  Attribute,
  Value,
  TransactionId,
  Datom,
  DatomInput,
  QueryOptions,
} from "./types.js";

// Database interface
export { Database } from "./database.js";

// Storage backends
export type { StorageBackend } from "./storage/backend.js";
export { MemoryBackend } from "./storage/memory.js";
export {
  SqlBackend,
  type SqlConnection,
  type SqlDialect,
  postgresDialect,
  sqliteDialect,
  mysqlDialect,
} from "./storage/sql.js";

// Datalog query engine
export {
  DatalogQueryEngine,
  type DatalogQuery,
  type QueryClause,
  type QueryResult,
} from "./datalog.js";
