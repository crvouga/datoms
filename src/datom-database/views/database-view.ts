/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type {DatalogQuery, DatalogQueryFindVariable} from '../../datalog/datalog.js';
import type {Attribute, Datom, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {ViewConfig} from './view-config.js';

/**
 * Type helper to extract result type from a DatalogQuery's find clause
 * Extracts the keys from the find clause and creates a record type where each key
 * maps to Value | Attribute | EntityId
 */
export type QueryResultFromFind<TFind extends Record<string, DatalogQueryFindVariable>> = Array<{
  [K in keyof TFind]: Value | Attribute | EntityId;
}>;

/**
 * Result of a datalog query execution
 * @template TFind The find clause from the DatalogQuery
 */
export type QueryResult<
  TFind extends Record<string, DatalogQueryFindVariable> = Record<string, DatalogQueryFindVariable>,
> = QueryResultFromFind<TFind>;

/**
 * Envelope containing datalog query result and optional metadata
 * @template TFind The find clause from the DatalogQuery
 */
export type QueryResultEnvelope<
  TFind extends Record<string, DatalogQueryFindVariable> = Record<string, DatalogQueryFindVariable>,
> = {
  data: QueryResult<TFind>;
  metadata?: Record<string, unknown>;
};

/**
 * Options for querying datoms (internal use only)
 * Used internally by query execution methods
 * @internal
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
  op?: boolean;
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
  /** Optional context for the query */
  context?: Record<string, unknown>;
  /** Optional view configuration */
  viewConfig?: ViewConfig;
}

/**
 * Read-only database view for time-travel queries (Datomic-like)
 * Provides minimal interface for querying historical or filtered database states
 * Views are immutable and cannot modify the database
 */
export interface DatabaseView {
  /**
   * Execute a datalog query against this database view
   * @param query Datalog query to execute
   * @returns Envelope containing query results and optional metadata with type-safe keys from the find clause
   * @example
   * const dbPast = db.asOf(100);
   * const { data: results } = await dbPast.query({
   *   find: { "movie/id": ["?id"], "movie/title": ["?title"] },
   *   where: [{ e: "?id", a: "tmdb.movie/title", v: "?title" }]
   * });
   * // results is typed as Array<{ "movie/id": Value | Attribute | EntityId, "movie/title": Value | Attribute | EntityId }>
   * // or
   * const envelope = await dbPast.query({ ... });
   * console.log(envelope.data); // The query results
   * console.log(envelope.metadata); // Implementation-specific metadata (SQL queries, execution plans, etc.)
   */
  query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(query: DatalogQuery<keyof TFind & string> & {find: TFind}): Promise<QueryResultEnvelope<TFind>>;
}
