/**
 * Shared SQL helper functions and types
 */

import { parseAggregation } from "../in-memory/parser.js";
import { POSTGRES_AGGREGATIONS } from "../postgres/registry.js";
import { SQLITE_AGGREGATIONS } from "../sqlite/registry.js";
import type { DatabaseType, SQLAggregationResult } from "./types.js";
/**
 * Escape a column name for SQL
 */
export function escapeColumnName(name: string, dbType: DatabaseType): string {
  // Remove question mark prefix if present
  const cleanName = name.startsWith("?") ? name.slice(1) : name;

  if (dbType === "postgresql") {
    // PostgreSQL uses double quotes for identifiers
    return `"${cleanName.replace(/"/g, '""')}"`;
  } else {
    // SQLite uses double quotes for identifiers
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleanName)) {
      return cleanName;
    }
    return `"${cleanName.replace(/"/g, '""')}"`;
  }
}

/**
 * Escape a value for SQL (for default values)
 */
export function escapeValue(
  value: string | number,
  _dbType: DatabaseType
): string {
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
 * Get SQLite JSON text extraction expression
 */
export function getSQLiteJSONTextExtraction(
  variableColumn: string,
  isValueColumn: boolean
): string {
  if (!isValueColumn) {
    return variableColumn;
  }
  return `JSON_EXTRACT(${variableColumn}, '$')`;
}

/**
 * Get value extraction expression for numeric operations
 */
export function getValueExtraction(
  variableColumn: string,
  isValueColumn: boolean,
  dbType: DatabaseType
): string {
  if (!isValueColumn) {
    return variableColumn;
  }
  if (dbType === "postgresql") {
    return `(${variableColumn}::jsonb#>>'{}')::numeric`;
  } else {
    return `CAST(JSON_EXTRACT(${variableColumn}, '$') AS REAL)`;
  }
}

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

  const registry =
    dbType === "postgresql" ? POSTGRES_AGGREGATIONS : SQLITE_AGGREGATIONS;
  const def = registry.get(agg.type);
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
