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
const POSTGRES_REGISTRY: Map<string, SQLAggregationDefinition> = new Map();

/**
 * Register a PostgreSQL SQL aggregation function
 */
export function registerSQLAggregation(
  name: string,
  definition: SQLAggregationDefinition
): void {
  POSTGRES_REGISTRY.set(name, definition);
}

/**
 * Get PostgreSQL SQL aggregation definition
 */
export function getSQLAggregationDefinition(
  name: string
): SQLAggregationDefinition | undefined {
  return POSTGRES_REGISTRY.get(name);
}
