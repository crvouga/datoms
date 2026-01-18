/**
 * Internal database view interface for implementation details
 * Used internally by database views and implementations
 * Not part of the public API
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, TransactionId } from "../../datoms.js";
import { DatomDatabase } from "../datom-database.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import { DatabaseView, DatomsParams } from "./database-view.js";

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

/**
 * Internal database view interface
 * Contains methods needed by database views and internal operations
 * This interface is separate from the public DatomDatabase interface
 * @internal
 */
export interface InternalDatabaseView extends DatomDatabase {
  /**
   * Execute a query with view configuration.
   * This method routes queries to the appropriate implementation method based on view config.
   * @param options Query options
   * @param viewConfig View configuration (asOf, since, history, current, or speculative)
   * @returns Array of matching datoms
   * @internal
   */
  _executeQuery(
    options: DatomsParams,
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
  _executeDatalogQuery(
    query: DatalogQuery,
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig
  ): Promise<QueryResult>;
}

/**
 * Database view that is configured with a view config
 * Used to create database views with specific configurations
 * @internal
 */
export class ConfiguredDatabaseView implements DatabaseView {
  constructor(
    private db: InternalDatabaseView,
    private viewConfig: ViewConfig
  ) {}

  async datoms(options: DatomsParams): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    validateQueryOptions(options);

    // Route to implementation with view config
    return this.db._executeQuery(options, this.viewConfig);
  }

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    return this.db._executeDatalogQuery(query, context, this.viewConfig);
  }
}
