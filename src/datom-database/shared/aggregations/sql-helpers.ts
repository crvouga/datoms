/**
 * SQL aggregation helpers - convert aggregation expressions to SQL aggregate functions
 * Returns null for aggregations not supported by SQL
 */

import { parseAggregation } from "./parser.js";

export type DatabaseType = "postgresql" | "sqlite";

/**
 * Result of converting an aggregation to SQL
 */
export interface SQLAggregationResult {
  /** SQL expression for the aggregation, or null if not supported */
  sql: string | null;
  /** Whether this aggregation requires GROUP BY */
  requiresGroupBy: boolean;
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

  const { type, defaultValue } = agg;

  // Handle JSON extraction for value columns (v is stored as JSON)
  // For aggregations on numeric values, we need to extract the numeric value
  const isValueColumn = variableColumn.includes(".v");

  // PostgreSQL JSONB extraction: values are stored as JSONB scalars (e.g., "NYC" stored as '"NYC"')
  // The v column in PostgreSQL is stored as JSONB type
  // For JSONB scalar strings, we need to extract the text value
  // Use jsonb_typeof to check the type and extract accordingly
  // For strings: use #>>'{}' to extract root value as text (removes quotes automatically)
  // For other types: cast to text
  // For count-distinct, min, max: extract as text for comparison
  // For sum, avg: extract as numeric
  const jsonbTextExtraction =
    isValueColumn && dbType === "postgresql"
      ? `CASE 
           WHEN jsonb_typeof(${variableColumn}::jsonb) = 'string' 
           THEN ${variableColumn}::jsonb#>>'{}'
           ELSE ${variableColumn}::jsonb::text
         END`
      : isValueColumn
        ? `JSON_EXTRACT(${variableColumn}, '$')`
        : variableColumn;

  const valueExtraction = isValueColumn
    ? dbType === "postgresql"
      ? `(${variableColumn}::jsonb#>>'{}')::numeric`
      : `CAST(JSON_EXTRACT(${variableColumn}, '$') AS REAL)`
    : variableColumn;

  switch (type) {
    case "count":
      // COUNT(*) counts all rows, COUNT(column) counts non-null values
      return {
        sql: `COUNT(*) AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      };

    case "count-distinct": {
      // For JSONB columns, we need to extract the value first as text
      const distinctColumn = isValueColumn
        ? jsonbTextExtraction
        : variableColumn;
      return {
        sql: `COUNT(DISTINCT ${distinctColumn}) AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      };
    }

    case "sum":
      return {
        sql: isValueColumn
          ? `SUM(${valueExtraction}) AS ${escapeColumnName(outputKey, dbType)}`
          : `SUM(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      };

    case "avg":
      return {
        sql: isValueColumn
          ? `AVG(${valueExtraction}) AS ${escapeColumnName(outputKey, dbType)}`
          : `AVG(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      };

    case "min": {
      // For min/max on value columns, extract as numeric for proper numeric comparison
      // This ensures 50 < 100 instead of "100" < "50" lexicographically
      // Use valueExtraction which extracts JSONB values as numeric
      const minColumn = isValueColumn ? valueExtraction : variableColumn;
      const minDefault =
        defaultValue !== undefined
          ? `COALESCE(MIN(${minColumn}), ${escapeValue(defaultValue, dbType)})`
          : `MIN(${minColumn})`;
      return {
        sql: `${minDefault} AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      };
    }

    case "max": {
      // For min/max on value columns, extract as numeric for proper numeric comparison
      const maxColumn = isValueColumn ? valueExtraction : variableColumn;
      const maxDefault =
        defaultValue !== undefined
          ? `COALESCE(MAX(${maxColumn}), ${escapeValue(defaultValue, dbType)})`
          : `MAX(${maxColumn})`;
      return {
        sql: `${maxDefault} AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      };
    }

    case "distinct":
      // PostgreSQL supports ARRAY_AGG(DISTINCT ...), SQLite needs custom handling
      if (dbType === "postgresql") {
        return {
          sql: `ARRAY_AGG(DISTINCT ${variableColumn}) AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      }
      // SQLite doesn't have a simple DISTINCT aggregation - return null
      return { sql: null, requiresGroupBy: false };

    case "median":
      if (dbType === "postgresql") {
        return {
          sql: isValueColumn
            ? `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${valueExtraction}) AS ${escapeColumnName(outputKey, dbType)}`
            : `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      }
      // SQLite doesn't have PERCENTILE_CONT - return null
      return { sql: null, requiresGroupBy: false };

    case "variance":
      if (dbType === "postgresql") {
        return {
          sql: isValueColumn
            ? `VAR_POP(${valueExtraction}) AS ${escapeColumnName(outputKey, dbType)}`
            : `VAR_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      }
      // SQLite doesn't have VAR_POP - return null
      return { sql: null, requiresGroupBy: false };

    case "stddev":
      if (dbType === "postgresql") {
        return {
          sql: isValueColumn
            ? `STDDEV_POP(${valueExtraction}) AS ${escapeColumnName(outputKey, dbType)}`
            : `STDDEV_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      }
      // SQLite doesn't have STDDEV_POP - return null
      return { sql: null, requiresGroupBy: false };

    case "rand":
    case "sample":
      // Random/sample aggregations require seed-based selection which can't be easily expressed in SQL
      // Return null to indicate this should be handled in-memory
      return { sql: null, requiresGroupBy: false };

    default:
      // Unknown aggregation type - return null
      return { sql: null, requiresGroupBy: false };
  }
}

/**
 * Escape a column name for SQL
 */
function escapeColumnName(name: string, dbType: DatabaseType): string {
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
function escapeValue(value: string | number, _dbType: DatabaseType): string {
  if (typeof value === "number") {
    return String(value);
  }
  // String values need to be quoted and escaped
  return `'${String(value).replace(/'/g, "''")}'`;
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
