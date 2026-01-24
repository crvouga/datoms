/**
 * SQL connection adapter interface for SQL database implementations
 */

import type {DatabaseRow, SQLParams} from './types.js';

/**
 * SQL connection interface that abstracts different SQL libraries
 */
export interface SQLDatabase {
  query(sql: string, params?: SQLParams): Promise<DatabaseRow[]>;
  execute(sql: string, params?: SQLParams): Promise<void>;
  transaction(callback: (transaction: SQLDatabaseTransaction) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface SQLDatabaseTransaction {
  execute(sql: string, params?: SQLParams): Promise<void>;
  query(sql: string, params?: SQLParams): Promise<DatabaseRow[]>;
}
