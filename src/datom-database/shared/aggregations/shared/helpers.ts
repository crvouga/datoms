/**
 * Shared SQL helper functions
 */

import type { DatabaseType } from "./sql-types.js";

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
