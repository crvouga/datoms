/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */

import type { Datom } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */
export class CurrentDatabaseView extends BaseDatabaseView {
  constructor(db: InternalDatabaseView) {
    super(db);
  }

  protected getViewConfig(): ViewConfig {
    return { type: "current" };
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Route to implementation with view config
    const viewConfig = this.getViewConfig();
    return this.db.executeQueryWithViewConfig(options, viewConfig);
  }
}
