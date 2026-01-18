/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */

import type { Datom } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */
export class HistoryDatabaseView extends BaseDatabaseView {
  constructor(db: InternalDatabaseView) {
    super(db);
  }

  protected getViewConfig(): ViewConfig {
    return { type: "history" };
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Route to implementation with view config
    return this.db.executeQueryWithViewConfig(options, this.getViewConfig());
  }
}
