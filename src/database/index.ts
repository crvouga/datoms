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
export { SqlDatabase } from "./database-sql.js";
// Note: SQLiteDatabase is test-only and not exported here
// Users should create their own SqlDatabase implementations with their preferred SQL connection

// SQL utilities
export { mysqlDialect, postgresDialect, sqliteDialect } from "./sql-utils.js";
export type { SqlConnection, SqlDialect } from "./sql-utils.js";

// Datalog query types
export {
  type DatalogQuery,
  type QueryClause,
  type QueryResult,
} from "./datalog.js";
