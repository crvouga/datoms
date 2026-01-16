/**
 * PostgreSQL connection implementation using PGLite (embedded PostgreSQL)
 *
 * NOTE: This is a test-only implementation. It depends on the `@electric-sql/pglite` library
 * and should not be included in the main library bundle.
 */

import { PGlite } from "@electric-sql/pglite";
import type { SqlConnection } from "../sql-connection-adapter.js";

/**
 * PGLite connection wrapper that implements SqlConnection interface
 */
export class PGLiteConnection implements SqlConnection {
  private db: PGlite;
  private inTransaction: boolean = false;
  private closed: boolean = false;
  private readyPromise: Promise<void>;

  constructor(dataDir: string = "memory://") {
    this.db = new PGlite(dataDir, {
      relaxedDurability: true,
    });
    this.readyPromise = this.db.waitReady;
  }

  /**
   * Convert parameterized query from ? placeholders to PostgreSQL $1, $2, ... syntax
   */
  private convertParams(sql: string, params?: any[]): [string, any[]] {
    if (!params || params.length === 0) {
      return [sql, []];
    }

    let paramIndex = 1;
    const convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
    return [convertedSql, params];
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    await this.readyPromise;
    const [convertedSql, convertedParams] = this.convertParams(sql, params);

    const result = await this.db.query(convertedSql, convertedParams);

    // PGLite returns JSONB values as JavaScript primitives/objects
    // We need to convert ALL values to JSON strings for consistency with SQLite
    // This ensures that the query method can always JSON.parse them
    return result.rows.map((row: any) => {
      const convertedRow: any = { ...row };
      // Convert value to JSON string if it exists
      if (convertedRow.value !== null && convertedRow.value !== undefined) {
        // Always stringify to ensure consistency - PGLite JSONB returns
        // primitives directly, but we need them as JSON strings
        convertedRow.value = JSON.stringify(convertedRow.value);
      }
      // Handle BIGINT transaction IDs - PGLite can return them as strings or bigints
      // Convert to number for consistency
      if (convertedRow.tx !== undefined) {
        if (typeof convertedRow.tx === "bigint") {
          convertedRow.tx = Number(convertedRow.tx);
        } else if (typeof convertedRow.tx === "string") {
          convertedRow.tx = parseInt(convertedRow.tx, 10);
        }
      }
      if (convertedRow.last_tx !== undefined) {
        if (typeof convertedRow.last_tx === "bigint") {
          convertedRow.last_tx = Number(convertedRow.last_tx);
        } else if (typeof convertedRow.last_tx === "string") {
          convertedRow.last_tx = parseInt(convertedRow.last_tx, 10);
        }
      }
      return convertedRow;
    });
  }

  async execute(sql: string, params?: any[]): Promise<void> {
    await this.readyPromise;
    const [convertedSql, convertedParams] = this.convertParams(sql, params);
    await this.db.query(convertedSql, convertedParams);
  }

  async beginTransaction(): Promise<void> {
    if (this.inTransaction) {
      throw new Error("Transaction already in progress");
    }
    await this.readyPromise;
    await this.db.exec("BEGIN");
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error("No transaction in progress");
    }
    await this.readyPromise;
    await this.db.exec("COMMIT");
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error("No transaction in progress");
    }
    await this.readyPromise;
    await this.db.exec("ROLLBACK");
    this.inTransaction = false;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return; // Already closed
    }
    this.closed = true;

    // Rollback any active transaction
    if (this.inTransaction) {
      await this.rollbackTransaction();
    }

    await this.db.close();
  }
}
