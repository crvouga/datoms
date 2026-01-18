/**
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
 */

import type { Datom } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import type {
  InternalDatabaseView,
  ViewConfig,
} from "./internal-database-view.js";

/**
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
 */
export class SpeculativeDatabaseView extends BaseDatabaseView {
  constructor(
    db: InternalDatabaseView,
    private speculativeAdds: Datom[],
    private speculativeSubs: Datom[]
  ) {
    super(db);
  }

  protected getViewConfig(): ViewConfig {
    return {
      type: "speculative",
      adds: this.speculativeAdds,
      subs: this.speculativeSubs,
    };
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Route to implementation with view config
    return this.db.executeQueryWithViewConfig(options, this.getViewConfig());
  }
}
