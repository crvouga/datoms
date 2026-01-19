/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery } from "../../datalog/datalog.js";
import type {
  Attribute,
  Datom,
  DatomOperation,
  TransactionId,
  Value,
} from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";

/**
 * Configuration for database views
 * Views use this to pass their configuration to implementations
 * @internal
 */
export type ViewConfig =
  | { type: "current" }
  | { type: "asOf"; txId: TransactionId }
  | { type: "since"; txId: TransactionId }
  | { type: "history" }
  | { type: "speculative"; datoms: Datom[] };

export type DatomsResult = Array<Datom>;

/**
 * Result of a datalog query execution
 */
export type QueryResult = Array<Record<string, Value | Attribute | EntityId>>;

/**
 * Envelope containing datoms query result and optional metadata
 */
export type DatomsResultEnvelope = {
  data: DatomsResult;
  metadata?: Record<string, unknown>;
};

/**
 * Envelope containing datalog query result and optional metadata
 */
export type QueryResultEnvelope = {
  data: QueryResult;
  metadata?: Record<string, unknown>;
};

/**
 * Read-only database view for time-travel queries (Datomic-like)
 * Provides minimal interface for querying historical or filtered database states
 * Views are immutable and cannot modify the database
 */
export type DatabaseView = {
  /**
   * Query datoms from the database view using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * const dbPast = db.asOf(100);
   * const datoms = await dbPast.datoms({ entity: 123 });
   */
  datoms(options: DatomsQuery): Promise<DatomsResult>;

  /**
   * Query datoms from the database view with metadata envelope
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Envelope containing datoms result and optional metadata
   * @example
   * const dbPast = db.asOf(100);
   * const envelope = await dbPast.datomsWithMetadata({ entity: 123 });
   * console.log(envelope.data); // The datoms
   * console.log(envelope.metadata); // Implementation-specific metadata (SQL queries, etc.)
   */
  datomsWithMetadata(
    options: DatomsQuery & {
      viewConfig: ViewConfig;
      context?: Record<string, unknown>;
    }
  ): Promise<DatomsResultEnvelope>;

  /**
   * Execute a datalog query against this database view
   * @param query Datalog query to execute
   * @param context Optional context object for hooks
   * @returns Query results as an array of records
   * @example
   * const dbPast = db.asOf(100);
   * const results = await dbPast.query({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   */
  query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult>;

  /**
   * Execute a datalog query against this database view with metadata envelope
   * @param query Datalog query to execute
   * @param context Optional context object for hooks
   * @returns Envelope containing query results and optional metadata
   * @example
   * const dbPast = db.asOf(100);
   * const envelope = await dbPast.queryWithMetadata({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   * console.log(envelope.data); // The query results
   * console.log(envelope.metadata); // Implementation-specific metadata (SQL queries, execution plans, etc.)
   */
  queryWithMetadata(
    query: DatalogQuery & {
      viewConfig: ViewConfig;
      context?: Record<string, unknown>;
    }
  ): Promise<QueryResultEnvelope>;
};

/**
 * Options for querying datoms
 */
export interface DatomsQuery {
  /** Filter by entity ID */
  e?: EntityId;
  /** Filter by attribute */
  a?: Attribute;
  /** Filter by value */
  v?: Value;
  /** Filter by transaction ID (exact match). Mutually exclusive with txMax */
  tx?: TransactionId;
  /** Filter by maximum transaction ID (tx <= txMax). Mutually exclusive with tx */
  txMax?: TransactionId;
  /** Filter by operation type */
  op?: DatomOperation;
  /** Limit the number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Hint for which index to use (backend-specific, may be ignored) */
  indexHint?: string | string[];
  /** Maximum query execution time in milliseconds */
  timeoutMs?: number;
  /** Maximum number of results allowed (throws QueryResultSizeError if exceeded) */
  maxResultSize?: number;
}
