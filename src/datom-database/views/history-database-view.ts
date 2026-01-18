/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import type { DatabaseView } from "./database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */
export class HistoryDatabaseView implements DatabaseView {
  private viewConfig: ViewConfig;

  constructor(private db: InternalDatabaseView) {
    this.viewConfig = { type: "history" };
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
