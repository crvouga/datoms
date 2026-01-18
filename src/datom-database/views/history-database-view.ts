/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */

import type { Datom, QueryOptions } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import { InternalDatabaseView } from "./internal-database-view.js";

/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */
export class HistoryDatabaseView extends BaseDatabaseView {
  constructor(db: InternalDatabaseView) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Use implementation-specific method for optimized SQL queries
    return this.db.executeHistoryQuery(options);
  }
}
