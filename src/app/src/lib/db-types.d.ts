/**
 * Type definitions for the database instance in the query editor
 * These types are used by Monaco Editor for IntelliSense
 */

import type {QueryResult} from '../../../datalog';
import type {DatomDatabase} from '../../../datom-database/datom-database';

declare global {
  /**
   * Database instance available in the query editor
   * Use this to query and transact data
   *
   * @example
   * // Query movies
   * const { data: results } = await db.query({
   *   find: { "movie/title": ["?title"] },
   *   where: [
   *     { e: "?movie/id", a: "tmdb.movie/title", v: "?title" }
   *   ],
   *   limit: 10
   * });
   *
   * @example
   * // Get datoms for an entity
   * const { data: results } = await db.query({
   *   find: { e: ["?e"], a: ["?a"], v: ["?v"] },
   *   where: [{ e: 123, a: "?a", v: "?v" }]
   * });
   *
   * @example
   * // Transact data
   * await db.transact([
   *   { op: true, e: 1, a: "name", v: "Alice" }
   * ]);
   */
  const db: DatomDatabase;

  /**
   * Helper function to format query results as JSON string
   */
  function formatResults(results: QueryResult): string;
}
