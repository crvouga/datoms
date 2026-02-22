/**
 * Types for SQL database operations
 */

/**
 * A database row result - represents a row returned from a SQL query
 * Properties are string keys with unknown values (will be typed by consumers)
 */
export type DatabaseRow = Record<string, unknown>;

/**
 * SQL query parameters - array of values to bind to query placeholders
 */
export type SQLParams = unknown[];
