/**
 * Database view showing only changes after a specific transaction ID (since query)
 * Filters queries to only include datoms with tx > txId
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, TransactionId } from "../../datoms.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import type { DatabaseView, DatomsParams } from "./database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing only changes after a specific transaction ID (since query)
 * Filters queries to only include datoms with tx > txId
 */
export class SinceDatabaseView implements DatabaseView {
  private viewConfig: ViewConfig;

  constructor(
    private db: InternalDatabaseView,
    txId: TransactionId
  ) {
    this.viewConfig = { type: "since", txId };
  }

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
    // Route query to implementation with view config
    return this.db._executeDatalogQuery(query, context, this.viewConfig);
  }
}
