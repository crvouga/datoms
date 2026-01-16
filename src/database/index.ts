/**
 * Database module entry point
 */

// Core types
export type {
  Attribute,
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";

// Database classes
export { Database } from "./database.js";
export { InMemoryDatabase } from "./database-in-memory.js";
export { SQLiteDatabase } from "./database-sqlite.js";
export { PostgreSQLDatabase } from "./database-postgres.js";
// Note: SQL connection implementations (SQLiteConnection, PostgresConnection) are test-only
// Users should create their own SqlConnection implementations with their preferred SQL libraries

// SQL connection adapter
export type { SqlConnection } from "./sql-connection-adapter.js";

// Datalog query types
export {
  type DatalogQuery,
  type QueryClause,
  type QueryResult,
} from "./datalog.js";
