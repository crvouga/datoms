/**
 * SQL aggregation registry - registration system for SQL aggregations
 */

import type { DatabaseType, SQLAggregationResult } from "./sql-types.js";

/**
 * SQL aggregation converter function
 */
export type SQLAggregationConverter = (
  variableColumn: string,
  outputKey: string,
  defaultValue: string | undefined,
  isValueColumn: boolean,
  dbType: DatabaseType
) => SQLAggregationResult | null;

/**
 * SQL aggregation definition
 */
export interface SQLAggregationDefinition {
  convert: SQLAggregationConverter;
}

// Separate registries for each database type
const POSTGRES_REGISTRY: Map<string, SQLAggregationDefinition> = new Map();
const SQLITE_REGISTRY: Map<string, SQLAggregationDefinition> = new Map();

/**
 * Register an SQL aggregation function
 */
export function registerSQLAggregation(
  name: string,
  definition: SQLAggregationDefinition,
  dbType: "postgresql" | "sqlite"
): void {
  const registry =
    dbType === "postgresql" ? POSTGRES_REGISTRY : SQLITE_REGISTRY;
  registry.set(name, definition);
}

/**
 * Get SQL aggregation definition
 */
export function getSQLAggregationDefinition(
  name: string,
  dbType: "postgresql" | "sqlite"
): SQLAggregationDefinition | undefined {
  const registry =
    dbType === "postgresql" ? POSTGRES_REGISTRY : SQLITE_REGISTRY;
  return registry.get(name);
}
