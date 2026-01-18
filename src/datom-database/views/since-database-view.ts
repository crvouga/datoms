/**
 * Database view showing only changes after a specific transaction ID (since query)
 * Filters queries to only include datoms with tx > txId
 */

import type { Datom, TransactionId } from "../../datoms.js";
import type { QueryOptions } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import { InternalDatabaseView } from "./internal-database-view.js";

/**
 * Database view showing only changes after a specific transaction ID (since query)
 * Filters queries to only include datoms with tx > txId
 */
export class SinceDatabaseView extends BaseDatabaseView {
  constructor(
    db: InternalDatabaseView,
    private txId: TransactionId
  ) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Use implementation-specific method for optimized SQL queries
    return this.db.executeSinceQuery(options, this.txId);
  }
}
