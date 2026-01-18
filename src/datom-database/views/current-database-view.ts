/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */

import type { Datom, QueryOptions } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import { InternalDatabaseView } from "./internal-database-view.js";

/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */
export class CurrentDatabaseView extends BaseDatabaseView {
  constructor(db: InternalDatabaseView) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Use the database's internal query method via the public accessor
    return this.db.datoms(options);
  }
}
