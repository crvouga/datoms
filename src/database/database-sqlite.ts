/**
 * SQLite database implementation using Bun's built-in SQLite support
 *
 * NOTE: This is a test-only implementation. It depends on Bun's SQLite API
 * and should not be included in the main library bundle. Users should inject
 * their own SQL connections using the SqlDatabase class.
 */

import { Database as BunDatabase } from "bun:sqlite";
import { SqlDatabase } from "./database-sql.js";
import type { SqlConnection, SqlDialect } from "./sql-utils.js";
import { sqliteDialect } from "./sql-utils.js";

/**
 * SQLite connection wrapper that implements SqlConnection interface
 */
class SQLiteConnection implements SqlConnection {
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

  async beginTransaction(): Promise<void> {
    await this.execute("BEGIN TRANSACTION");
  }

  async commitTransaction(): Promise<void> {
    await this.execute("COMMIT");
  }

  async rollbackTransaction(): Promise<void> {
    await this.execute("ROLLBACK");
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * SQLite database implementation
 * Uses Bun's built-in SQLite support
 *
 * NOTE: This is test-only. For production use, create your own SqlDatabase
 * implementation with your preferred SQL connection library.
 */
export class SQLiteDatabase extends SqlDatabase {
  private connectionWrapper: SQLiteConnection;

  constructor(filename: string = ":memory:", tableName: string = "datoms") {
    const connection = new SQLiteConnection(filename);
    super(connection, tableName);
    this.connectionWrapper = connection;
  }

  protected getDialect(): SqlDialect {
    return sqliteDialect;
  }

  async close(): Promise<void> {
    await super.close();
    // SQLiteConnection.close() is already called by super.close()
    // but we ensure it's properly closed
    if (this.connectionWrapper) {
      await this.connectionWrapper.close();
    }
  }
}
