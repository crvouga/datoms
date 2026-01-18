/**
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
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
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
 */
export class SpeculativeDatabaseView implements DatabaseView {
  private viewConfig: ViewConfig;

  constructor(
    private db: InternalDatabaseView,
    speculativeAdds: Datom[],
    speculativeSubs: Datom[]
  ) {
    this.viewConfig = {
      type: "speculative",
      adds: speculativeAdds,
      subs: speculativeSubs,
    };
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
