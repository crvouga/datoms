/**
 * Database view showing state at a specific transaction ID (as-of query)
 * Filters queries to only include datoms with tx <= txId and deduplicates by (entity, attribute)
 */

import type { Datom, QueryOptions, TransactionId } from "../../types.js";
import { BaseDatabaseView } from "./base-database-view.js";
import { InternalDatabaseView } from "./internal-database-view.js";

/**
 * Database view showing state at a specific transaction ID (as-of query)
 * Filters queries to only include datoms with tx <= txId and deduplicates by (entity, attribute)
 */
export class AsOfDatabaseView extends BaseDatabaseView {
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
    return this.db.executeAsOfQuery(options, this.txId);
  }
}
