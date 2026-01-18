/**
 * Internal database view interface for implementation details
 * Used internally by database views and implementations
 * Not part of the public API
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, TransactionId } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { DatomDatabase } from "../datom-database.js";

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
  | { type: "speculative"; adds: Datom[]; subs: Datom[] };

/**
 * Internal database view interface
 * Contains methods needed by database views and internal operations
 * This interface is separate from the public DatomDatabase interface
 * @internal
 */
export interface InternalDatabaseView extends DatomDatabase {
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

  /**
   * Execute a query with view configuration.
   * This method routes queries to the appropriate implementation method based on view config.
   * @param options Query options
   * @param viewConfig View configuration (asOf, since, history, current, or speculative)
   * @returns Array of matching datoms
   * @internal
   */
  executeQueryWithViewConfig(
    options: QueryOptions,
    viewConfig: ViewConfig
  ): Promise<Datom[]>;

  /**
   * Execute a datalog query with view configuration.
   * This method routes datalog queries to the appropriate implementation method based on view config.
   * @param query Datalog query to execute
   * @param context Optional context object for hooks
   * @param viewConfig View configuration (asOf, since, history, current, or speculative)
   * @returns Query results as an array of records
   * @internal
   */
  executeDatalogQueryWithViewConfig(
    query: DatalogQuery,
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig
  ): Promise<QueryResult>;
}
