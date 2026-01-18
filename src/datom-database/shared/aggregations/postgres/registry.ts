/**
 * PostgreSQL aggregation registry - registration system for PostgreSQL SQL aggregations
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

// PostgreSQL registry
export const POSTGRES_AGGREGATIONS: Map<string, SQLAggregationDefinition> =
  new Map();
