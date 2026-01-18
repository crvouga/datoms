/**
 * Internal database view interface for implementation details
 * Used internally by database views and implementations
 * Not part of the public API
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, TransactionId } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";

/**
 * Internal database view interface
 * Contains methods needed by database views and internal operations
 * This interface is separate from the public DatomDatabase interface
 * @internal
 */
export interface InternalDatabaseView {
  /**
   * Query datoms from the database view using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * const dbPast = db.asOf(100);
   * const datoms = await dbPast.datoms({ entity: 123 });
   */
  datoms(options: QueryOptions): Promise<Datom[]>;

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
   * Get raw datoms without deduplication for time-travel queries.
   * This method is used by database views to get all datoms matching filters
   * before applying time-travel specific deduplication logic.
   * Implementations must provide backend-specific logic to return undeduplicated results.
   * @param options Query options
   * @returns Array of matching datoms without deduplication
   * @internal
   */
  getRawDatoms(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute the actual query (implemented by implementations)
   * This is the core query execution method used internally.
   * @param options Query options
   * @returns Array of matching datoms
   * @internal
   */
  executeQuery(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute an asOf query - returns datoms with tx <= txId, deduplicated by (entity, attribute).
   * This method is called by AsOfDatabaseView to leverage database-native query optimization.
   * Implementations must provide backend-specific logic for efficient time-travel queries.
   * @param options Query options
   * @param txId Transaction ID to query as-of
   * @returns Array of matching datoms deduplicated by (entity, attribute)
   * @internal
   */
  executeAsOfQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]>;

  /**
   * Execute a history query - returns all datoms including sub, without deduplication.
   * This method is called by HistoryDatabaseView to leverage database-native query optimization.
   * Implementations must provide backend-specific logic for efficient history queries.
   * @param options Query options
   * @returns Array of all matching datoms (including sub)
   * @internal
   */
  executeHistoryQuery(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a since query - returns datoms with tx > txId, deduplicated by (entity, attribute, value).
   * This method is called by SinceDatabaseView to leverage database-native query optimization.
   * Implementations must provide backend-specific logic for efficient since queries.
   * @param options Query options
   * @param txId Transaction ID - only changes after this will be included
   * @returns Array of matching datoms deduplicated by (entity, attribute, value)
   * @internal
   */
  executeSinceQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]>;
}
