/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, QueryOptions, TransactionId } from "../../types.js";

/**
 * Read-only database view for time-travel queries (Datomic-like)
 * Provides minimal interface for querying historical or filtered database states
 * Views are immutable and cannot modify the database
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
