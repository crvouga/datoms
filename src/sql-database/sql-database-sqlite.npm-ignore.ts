/**
 * SQLite connection implementation using Bun's built-in SQLite support
 *
 * NOTE: This is a test-only implementation. It depends on Bun's SQLite API
 * and should not be included in the main library bundle.
 */

import { Database as BunDatabase } from "bun:sqlite";
import type { SQLDatabase } from "./sql-database.js";
import type { DatabaseRow, SQLParams } from "./types.js";

/**
 * SQLite connection wrapper that implements SqlConnection interface
 */
export class SQLiteSQLDatabase implements SQLDatabase {
  private db: BunDatabase;
  private inTransaction: boolean = false;

  constructor(filename: string = ":memory:") {
    this.db = new BunDatabase(filename);
  }

  async query(sql: string, params?: SQLParams): Promise<DatabaseRow[]> {
    const stmt = this.db.prepare(sql);
    // Bun SQLite accepts positional parameters via spread operator
    // Type assertion needed because SQLParams (unknown[]) is more permissive
    // than Bun's strict SQLQueryBindings type, but runtime values are valid
    // @ts-expect-error - SQLParams is unknown[] but Bun expects specific types; values are valid at runtime
    const results = stmt.all(...(params || []));
    return results as DatabaseRow[];
  }

  async execute(sql: string, params?: SQLParams): Promise<void> {
    const stmt = this.db.prepare(sql);
    // Bun SQLite accepts positional parameters via spread operator
    // Type assertion needed because SQLParams (unknown[]) is more permissive
    // than Bun's strict SQLQueryBindings type, but runtime values are valid
    // @ts-expect-error - SQLParams is unknown[] but Bun expects specific types; values are valid at runtime
    stmt.run(...(params || []));
  }

  async beginTransaction(): Promise<void> {
    if (this.inTransaction) {
      throw new Error("Transaction already in progress");
    }
    await this.execute("BEGIN TRANSACTION");
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error("No transaction in progress");
    }
    await this.execute("COMMIT");
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error("No transaction in progress");
    }
    await this.execute("ROLLBACK");
    this.inTransaction = false;
  }

  async close(): Promise<void> {
    if (this.inTransaction) {
      await this.rollbackTransaction();
    }
    this.db.close();
  }
}
