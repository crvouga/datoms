/**
 * SQL utilities and types for SQL database implementations
 */

/**
 * SQL connection interface that abstracts different SQL libraries
 */
export interface SqlConnection {
  query(sql: string, params?: any[]): Promise<any[]>;
  execute(sql: string, params?: any[]): Promise<void>;
  beginTransaction?(): Promise<void>;
  commitTransaction?(): Promise<void>;
  rollbackTransaction?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * SQL dialect-specific syntax
 */
export interface SqlDialect {
  textType: string;
  integerType: string;
  booleanType: string;
  jsonType: string;
  onConflict?: string;
}

/**
 * PostgreSQL dialect
 */
export const postgresDialect: SqlDialect = {
  textType: "TEXT",
  integerType: "BIGINT",
  booleanType: "BOOLEAN",
  jsonType: "JSONB",
  onConflict: "ON CONFLICT DO NOTHING",
};

/**
 * SQLite dialect
 */
export const sqliteDialect: SqlDialect = {
  textType: "TEXT",
  integerType: "INTEGER",
  booleanType: "INTEGER", // SQLite uses INTEGER for booleans
  jsonType: "TEXT", // SQLite stores JSON as TEXT
  onConflict: "ON CONFLICT DO NOTHING",
};

/**
 * MySQL dialect
 */
export const mysqlDialect: SqlDialect = {
  textType: "VARCHAR(255)",
  integerType: "BIGINT",
  booleanType: "BOOLEAN",
  jsonType: "JSON",
  onConflict: "ON DUPLICATE KEY UPDATE entity=entity", // MySQL syntax
};
