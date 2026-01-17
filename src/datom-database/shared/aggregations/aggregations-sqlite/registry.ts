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
const SQLITE_REGISTRY: Map<string, SQLAggregationDefinition> = new Map();

/**
 * Register a SQLite SQL aggregation function
 */
export function registerSQLAggregation(
  name: string,
  definition: SQLAggregationDefinition
): void {
  SQLITE_REGISTRY.set(name, definition);
}

/**
 * Get SQLite SQL aggregation definition
 */
export function getSQLAggregationDefinition(
  name: string
): SQLAggregationDefinition | undefined {
  return SQLITE_REGISTRY.get(name);
}
