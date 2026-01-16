/**
 * SQLite connection implementation using Bun's built-in SQLite support
 *
 * NOTE: This is a test-only implementation. It depends on Bun's SQLite API
 * and should not be included in the main library bundle.
 */

import { Database as BunDatabase } from "bun:sqlite";
import type { SqlConnection } from "../sql-utils.js";

/**
 * SQLite connection wrapper that implements SqlConnection interface
 */
export class SQLiteConnection implements SqlConnection {
  private db: BunDatabase;

  constructor(filename: string = ":memory:") {
    this.db = new BunDatabase(filename);
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    const stmt = this.db.prepare(sql);
    const results = stmt.all(...(params || []));
    return results as any[];
  }

  async execute(sql: string, params?: any[]): Promise<void> {
    const stmt = this.db.prepare(sql);
    stmt.run(...(params || []));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
