/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom } from "../../datoms.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import type { DatabaseView, DatomsParams } from "./database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */
export class CurrentDatabaseView implements DatabaseView {
  private viewConfig: ViewConfig;

  constructor(private db: InternalDatabaseView) {
    this.viewConfig = { type: "current" };
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
