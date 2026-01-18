/**
 * Database view showing state at a specific transaction ID (as-of query)
 * Filters queries to only include datoms with tx <= txId and deduplicates by (entity, attribute)
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, TransactionId } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import type { DatabaseView } from "./database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing state at a specific transaction ID (as-of query)
 * Filters queries to only include datoms with tx <= txId and deduplicates by (entity, attribute)
 */
export class AsOfDatabaseView implements DatabaseView {
  private viewConfig: ViewConfig;

  constructor(
    private db: InternalDatabaseView,
    txId: TransactionId
  ) {
    this.viewConfig = { type: "asOf", txId };
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    validateQueryOptions(options);

    // Route to implementation with view config
    return this.db.executeQueryWithViewConfig(options, this.viewConfig);
  }

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    // Route query to implementation with view config
    return this.db.executeDatalogQueryWithViewConfig(
      query,
      context,
      this.viewConfig
    );
  }
}
