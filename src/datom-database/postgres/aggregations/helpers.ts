/**
 * PostgreSQL SQL helper functions
 */

import { parseAggregation } from "../../in-memory/aggregations/parser.js";
import { POSTGRES_AGGREGATIONS } from "./registry.js";
import type { SQLAggregationResult } from "./types.js";

/**
 * Escape a column name for PostgreSQL SQL
 */
export function escapeColumnName(name: string): string {
  // Remove question mark prefix if present
  const cleanName = name.startsWith("?") ? name.slice(1) : name;
  // PostgreSQL uses double quotes for identifiers
  return `"${cleanName.replace(/"/g, '""')}"`;
}

/**
 * Escape a value for SQL (for default values)
 */
export function escapeValue(value: string | number): string {
  if (typeof value === "number") {
    return String(value);
  }
  // String values need to be quoted and escaped
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Get JSONB text extraction expression for PostgreSQL
 */
export function getPostgresJSONBTextExtraction(
  variableColumn: string,
  isValueColumn: boolean
): string {
  if (!isValueColumn) {
    return variableColumn;
  }
  return `CASE 
           WHEN jsonb_typeof(${variableColumn}::jsonb) = 'string' 
           THEN ${variableColumn}::jsonb#>>'{}'
           ELSE ${variableColumn}::jsonb::text
         END`;
}

/**
 * Get value extraction expression for numeric operations
 */
export function getValueExtraction(
  variableColumn: string,
  isValueColumn: boolean
): string {
  if (!isValueColumn) {
    return variableColumn;
  }
  return `(${variableColumn}::jsonb#>>'{}')::numeric`;
}

/**
 * Convert an aggregation expression to a SQL aggregate function
 * @param expr Aggregation expression from find clause
 * @param variableColumn SQL column reference for the variable (e.g., "d0.v")
 * @param outputKey Output key name for the aggregation (used as column alias)
 * @returns SQL aggregation expression or null if not supported
 */
export function aggregationToSQL(
  expr: unknown,
  variableColumn: string,
  outputKey: string
): SQLAggregationResult | null {
  const agg = parseAggregation(expr);
  if (!agg) {
    return null; // Not an aggregation
  }

  const def = POSTGRES_AGGREGATIONS.get(agg.type);
  if (!def) {
    return null; // Aggregation not supported for this database type
  }

  const isValueColumn = variableColumn.includes(".v");
  return def.convert(
    variableColumn,
    outputKey,
    agg.defaultValue,
    isValueColumn
  );
}

/**
 * Check if a query has aggregations that can be handled in SQL
 * @param find Find clause object
 * @returns Object with hasAggregations flag and whether all aggregations are SQL-supported
 */
export function checkSQLAggregations(find: { [key: string]: unknown }): {
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
      const result = aggregationToSQL(expr, "dummy", outputKey);
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
