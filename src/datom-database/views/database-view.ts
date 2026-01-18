/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, QueryOptions } from "../../types.js";

/**
 * Read-only database view for time-travel queries (Datomic-like)
 * Provides minimal interface for querying historical or filtered database states
 * Views are immutable and cannot modify the database
 */
export interface DatabaseView {
  /**
   * Query datoms from the database view using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * const dbPast = db.asOf(100);
   * const datoms = await dbPast.datoms({ entity: 123 });
   */
  datoms(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query against this database view
   * @param query Datalog query to execute
   * @param context Optional context object for hooks
   * @returns Query results as an array of records
   * @example
   * const dbPast = db.asOf(100);
   * const results = await dbPast.query({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   */
  query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult>;
}
