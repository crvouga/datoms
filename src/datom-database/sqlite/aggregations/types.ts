/**
 * SQLite aggregation types
 */

/**
 * Result of converting an aggregation to SQL
 */
export interface SQLAggregationResult {
  /** SQL expression for the aggregation, or null if not supported */
  sql: string | null;
  /** Whether this aggregation requires GROUP BY */
  requiresGroupBy: boolean;
}
