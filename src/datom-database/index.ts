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

// Transaction type
export type { Transaction } from "./datom-database.js";

// Error classes
export {
  CardinalityError,
  DatomDatabaseError,
  DatomTypeError,
  MigrationError,
  QuerySafetyError,
  TransactionConflictError,
  UniqueConstraintError,
} from "./errors.js";
