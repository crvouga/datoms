/**
 * SQLite connection implementation using Bun's built-in SQLite support
 *
 * NOTE: This is a test-only implementation. It depends on Bun's SQLite API
 * and should not be included in the main library bundle.
 */

import {Database as BunDatabase} from 'bun:sqlite';
import type {SQLDatabase, SQLDatabaseTransaction} from './sql-database.js';
import type {DatabaseRow, SQLParams} from './types.js';

/**
 * SQLite connection wrapper that implements SqlConnection interface
 */
export class SQLiteSQLDatabase implements SQLDatabase {
  private db: BunDatabase;

  constructor(filename = ':memory:') {
    this.db = new BunDatabase(filename);
  }

  async query(sql: string, params?: SQLParams): Promise<DatabaseRow[]> {
    const stmt = this.db.prepare(sql);
    // Bun SQLite accepts positional parameters via spread operator
    // Type trueion needed because SQLParams (unknown[]) is more permissive
    // than Bun's strict SQLQueryBindings type, but runtime values are valid
    // @ts-expect-error - SQLParams is unknown[] but Bun expects specific types; values are valid at runtime
    const results = stmt.all(...(params || []));
    return results as DatabaseRow[];
  }

  async execute(sql: string, params?: SQLParams): Promise<void> {
    const stmt = this.db.prepare(sql);
    // Bun SQLite accepts positional parameters via spread operator
    // Type trueion needed because SQLParams (unknown[]) is more permissive
    // than Bun's strict SQLQueryBindings type, but runtime values are valid
    // @ts-expect-error - SQLParams is unknown[] but Bun expects specific types; values are valid at runtime
    stmt.run(...(params || []));
  }

  async transaction(callback: (tx: SQLDatabaseTransaction) => Promise<void>): Promise<void> {
    try {
      await this.execute('BEGIN TRANSACTION');

      const tx: SQLDatabaseTransaction = {
        execute: async (sql: string, params?: SQLParams): Promise<void> => {
          const stmt = this.db.prepare(sql);
          // @ts-expect-error - SQLParams is unknown[] but Bun expects specific types; values are valid at runtime
          stmt.run(...(params || []));
        },
        query: async (sql: string, params?: SQLParams): Promise<DatabaseRow[]> => {
          const stmt = this.db.prepare(sql);
          // @ts-expect-error - SQLParams is unknown[] but Bun expects specific types; values are valid at runtime
          const results = stmt.all(...(params || []));
          return results as DatabaseRow[];
        },
      };

      await callback(tx);
      await this.execute('COMMIT');
    } catch (error) {
      await this.execute('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
