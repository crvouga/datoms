/**
 * SQLite aggregation registry - registration system for SQLite SQL aggregations
 */

import type { SQLAggregationResult } from "../shared/sql-types.js";

/**
 * SQL aggregation converter function
 */
export type SQLAggregationConverter = (
  variableColumn: string,
  outputKey: string,
  defaultValue: string | undefined,
  isValueColumn: boolean
) => SQLAggregationResult | null;

/**
 * SQL aggregation definition
 */
export interface SQLAggregationDefinition {
  convert: SQLAggregationConverter;
}

// SQLite registry
export const SQLITE_AGGREGATIONS: Map<string, SQLAggregationDefinition> =
  new Map();
