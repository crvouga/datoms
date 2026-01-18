/**
 * Base class for database views that filter queries by transaction ID
 * Provides common functionality for AsOf, History, and Since views
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { QuerySafetyError } from "../hook/hook.js";
import type { DatabaseView } from "./database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Base class for database views that filter queries by transaction ID
 * Provides common functionality for AsOf, History, and Since views
 */
export abstract class BaseDatabaseView implements DatabaseView {
  constructor(protected db: InternalDatabaseView) {}

  /**
   * Get the view configuration for this view
   * Each subclass must implement this to provide its specific config
   */
  protected abstract getViewConfig(): ViewConfig;

  abstract datoms(options: QueryOptions): Promise<Datom[]>;

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    // Route query to implementation with view config
    return this.db.executeDatalogQueryWithViewConfig(
      query,
      context,
      this.getViewConfig()
    );
  }

  /**
   * Validate that query has at least one filter or limit to prevent accidental full scans
   */
  protected validateQueryOptions(options: QueryOptions): void {
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }
  }
}
