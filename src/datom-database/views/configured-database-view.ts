/**
 * Internal database view interface for implementation details
 * Used internally by database views and implementations
 * Not part of the public API
 */

import type { DatalogQuery } from "../../datalog/datalog.js";
import type { Datom } from "../../datoms.js";
import type { DatomDatabase, ViewConfig } from "../datom-database.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import type {
  DatabaseView,
  DatomsQuery,
  DatomsResultEnvelope,
  QueryResult,
  QueryResultEnvelope,
} from "./database-view.js";

/**
 * Database view that is configured with a view config
 * Used to create database views with specific configurations
 * @internal
 */
export class ConfiguredDatabaseView implements DatabaseView {
  constructor(
    private db: DatomDatabase,
    private viewConfig: ViewConfig
  ) {}

  async datoms(options: DatomsQuery): Promise<Datom[]> {
    const envelope = await this.datomsWithMetadata(options);
    return envelope.data;
  }

  async datomsWithMetadata(
    options: DatomsQuery
  ): Promise<DatomsResultEnvelope> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    validateQueryOptions(options);

    // Route to implementation with view config
    return this.db._datoms(options, this.viewConfig);
  }

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    const envelope = await this.queryWithMetadata(query, context);
    return envelope.data;
  }

  async queryWithMetadata(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResultEnvelope> {
    return this.db._query(query, context, this.viewConfig);
  }
}
