/**
 * SQL aggregation helpers - convert aggregation expressions to SQL aggregate functions
 * Returns null for aggregations not supported by SQL
 */

import { parseAggregation } from "./shared/parser.js";
import { getSQLAggregationDefinition } from "./shared/sql-registry.js";
import type { DatabaseType, SQLAggregationResult } from "./shared/sql-types.js";

// Import implementations to register all SQL aggregations
import "./aggregations-postgres/index.js";
import "./aggregations-sqlite/index.js";

// Re-export types for convenience
export type { DatabaseType, SQLAggregationResult };

/**
 * Convert an aggregation expression to a SQL aggregate function
 * @param expr Aggregation expression from find clause
 * @param variableColumn SQL column reference for the variable (e.g., "d0.v")
 * @param dbType Database type (postgresql or sqlite)
 * @param outputKey Output key name for the aggregation (used as column alias)
 * @returns SQL aggregation expression or null if not supported
 */
export function aggregationToSQL(
  expr: unknown,
  variableColumn: string,
  dbType: DatabaseType,
  outputKey: string
): SQLAggregationResult | null {
  const agg = parseAggregation(expr);
  if (!agg) {
    return null; // Not an aggregation
  }

  const def = getSQLAggregationDefinition(agg.type, dbType);
  if (!def) {
    return null; // Aggregation not supported for this database type
  }

  const isValueColumn = variableColumn.includes(".v");
  return def.convert(
    variableColumn,
    outputKey,
    agg.defaultValue,
    isValueColumn,
    dbType
  );
}

/**
 * Check if a query has aggregations that can be handled in SQL
 * @param find Find clause object
 * @param dbType Database type
 * @returns Object with hasAggregations flag and whether all aggregations are SQL-supported
 */
export function checkSQLAggregations(
  find: { [key: string]: unknown },
  dbType: DatabaseType
): {
  hasAggregations: boolean;
  allSupported: boolean;
  hasUnsupported: boolean;
} {
  const findKeys = Object.keys(find);
  let hasAggregations = false;
  let hasUnsupported = false;

  for (const outputKey of findKeys) {
    const expr = find[outputKey];
    const agg = parseAggregation(expr);
    if (agg) {
      hasAggregations = true;
      // Check if this aggregation is supported
      const result = aggregationToSQL(expr, "dummy", dbType, outputKey);
      if (result === null || result.sql === null) {
        hasUnsupported = true;
      }
    }
  }

  return {
    hasAggregations,
    allSupported: hasAggregations && !hasUnsupported,
    hasUnsupported,
  };
}
