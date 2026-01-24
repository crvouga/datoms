/**
 * PostgreSQL SQL helper functions
 */

import type {DatalogQueryFindVariable} from '../../../datalog/datalog.js';
import type {SQLAggregationResult} from './types.js';

/**
 * Escape a column name for PostgreSQL SQL
 */
function escapeColumnName(name: string): string {
  // Remove question mark prefix if present
  const cleanName = name.startsWith('?') ? name.slice(1) : name;
  // PostgreSQL uses double quotes for identifiers
  return `"${cleanName.replace(/"/g, '""')}"`;
}

/**
 * Escape a value for SQL (for default values)
 */
function escapeValue(value: string | number): string {
  if (typeof value === 'number') {
    return String(value);
  }
  // String values need to be quoted and escaped
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Get JSONB text extraction expression for PostgreSQL
 */
function getPostgresJSONBTextExtraction(variableColumn: string, isValueColumn: boolean): string {
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
function getValueExtraction(variableColumn: string, isValueColumn: boolean): string {
  if (!isValueColumn) {
    return variableColumn;
  }
  return `(${variableColumn}::jsonb#>>'{}')::numeric`;
}

/**
 * Convert an aggregation expression to PostgreSQL SQL using a typesafe switch case
 * @param expr Aggregation expression from find clause
 * @param variableColumn SQL column reference for the variable (e.g., "d0.v")
 * @param outputKey Output key name for the aggregation (used as column alias)
 * @returns SQL aggregation expression or null if not supported
 */
function aggregationToPostgresSQL(
  expr: DatalogQueryFindVariable,
  variableColumn: string,
  outputKey: string,
): SQLAggregationResult | null {
  const isValueColumn = variableColumn.includes('.v');

  switch (expr.t) {
    case 'identity':
      return null; // Not an aggregation

    case 'count': {
      return {
        sql: `COUNT(*) AS ${escapeColumnName(outputKey)}`,
        requiresGroupBy: false,
      };
    }

    case 'count-distinct': {
      // For JSONB columns, we need to extract the value first as text
      const distinctColumn = isValueColumn
        ? getPostgresJSONBTextExtraction(variableColumn, isValueColumn)
        : variableColumn;
      return {
        sql: `COUNT(DISTINCT ${distinctColumn}) AS ${escapeColumnName(outputKey)}`,
        requiresGroupBy: false,
      };
    }

    case 'sum': {
      const sql = isValueColumn
        ? `SUM(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
        : `SUM(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    }

    case 'avg': {
      const sql = isValueColumn
        ? `AVG(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
        : `AVG(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    }

    case 'min': {
      // For min/max on value columns, extract as numeric for proper numeric comparison
      // This ensures 50 < 100 instead of "100" < "50" lexicographically
      const minColumn = isValueColumn
        ? getValueExtraction(variableColumn, isValueColumn)
        : variableColumn;
      const defaultValue = expr.count !== undefined ? String(expr.count) : undefined;
      const minDefault =
        defaultValue !== undefined
          ? `COALESCE(MIN(${minColumn}), ${escapeValue(defaultValue)})`
          : `MIN(${minColumn})`;
      return {
        sql: `${minDefault} AS ${escapeColumnName(outputKey)}`,
        requiresGroupBy: false,
      };
    }

    case 'max': {
      // For min/max on value columns, extract as numeric for proper numeric comparison
      const maxColumn = isValueColumn
        ? getValueExtraction(variableColumn, isValueColumn)
        : variableColumn;
      const defaultValue = expr.count !== undefined ? String(expr.count) : undefined;
      const maxDefault =
        defaultValue !== undefined
          ? `COALESCE(MAX(${maxColumn}), ${escapeValue(defaultValue)})`
          : `MAX(${maxColumn})`;
      return {
        sql: `${maxDefault} AS ${escapeColumnName(outputKey)}`,
        requiresGroupBy: false,
      };
    }

    case 'median': {
      const sql = isValueColumn
        ? `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
        : `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    }

    case 'variance': {
      const sql = isValueColumn
        ? `VAR_POP(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
        : `VAR_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    }

    case 'stddev': {
      const sql = isValueColumn
        ? `STDDEV_POP(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
        : `STDDEV_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    }

    case 'distinct': {
      // PostgreSQL supports ARRAY_AGG(DISTINCT ...)
      return {
        sql: `ARRAY_AGG(DISTINCT ${variableColumn}) AS ${escapeColumnName(outputKey)}`,
        requiresGroupBy: false,
      };
    }

    case 'rand':
    case 'sample':
      // Not supported in PostgreSQL aggregations
      return null;

    default: {
      // Exhaustiveness check - TypeScript will error if we miss a case
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
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
  outputKey: string,
): SQLAggregationResult | null {
  // Type guard to check if expr is a valid DatalogQueryFindVariable
  if (typeof expr !== 'object' || expr === null || !('t' in expr) || typeof expr.t !== 'string') {
    return null;
  }

  return aggregationToPostgresSQL(expr as DatalogQueryFindVariable, variableColumn, outputKey);
}
