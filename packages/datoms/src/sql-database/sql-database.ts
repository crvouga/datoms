/**
 * SQL connection adapter interface for SQL database implementations
 */

import type {DatabaseRow, SQLParams} from './types.js';

/**
 * SQL connection interface that abstracts different SQL libraries
 */
export interface SQLDatabase {
  query(sql: string, params?: SQLParams): Promise<DatabaseRow[]>;
  transaction(callback: (transaction: SQLDatabaseTransaction) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface SQLDatabaseTransaction {
  query(sql: string, params?: SQLParams): Promise<DatabaseRow[]>;
}
