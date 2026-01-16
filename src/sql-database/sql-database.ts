/**
 * SQL connection adapter interface for SQL database implementations
 */

/**
 * SQL connection interface that abstracts different SQL libraries
 */
export interface SqlDatabase {
  query(sql: string, params?: any[]): Promise<any[]>;
  execute(sql: string, params?: any[]): Promise<void>;
  beginTransaction?(): Promise<void>;
  commitTransaction?(): Promise<void>;
  rollbackTransaction?(): Promise<void>;
  close?(): Promise<void>;
}
