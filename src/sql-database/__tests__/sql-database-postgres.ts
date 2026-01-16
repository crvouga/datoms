/**
 * PostgreSQL connection implementation using node-postgres (pg)
 *
 * NOTE: This is a test-only implementation. It depends on the `pg` library
 * and should not be included in the main library bundle.
 */

import { Pool, PoolClient } from "pg";
import type { SqlDatabase } from "../sql-database.js";

/**
 * PostgreSQL connection wrapper that implements SqlConnection interface
 */
export class PostgresConnection implements SqlDatabase {
  private pool: Pool;
  private client?: PoolClient;
  private inTransaction: boolean = false;
  private closed: boolean = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 1, // Use single connection for test isolation
    });
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
    const [convertedSql, convertedParams] = this.convertParams(sql, params);

    let result;
    if (this.inTransaction && this.client) {
      result = await this.client.query(convertedSql, convertedParams);
    } else {
      result = await this.pool.query(convertedSql, convertedParams);
    }

    // PostgreSQL returns JSONB values as JavaScript primitives/objects
    // We need to convert ALL values to JSON strings for consistency with SQLite
    // This ensures that the query method can always JSON.parse them
    return result.rows.map((row: any) => {
      const convertedRow: any = { ...row };
      // Convert value to JSON string if it exists
      if (convertedRow.value !== null && convertedRow.value !== undefined) {
        // Always stringify to ensure consistency - PostgreSQL JSONB returns
        // primitives directly, but we need them as JSON strings
        convertedRow.value = JSON.stringify(convertedRow.value);
      }
      // Handle BIGINT transaction IDs - PostgreSQL can return them as strings or bigints
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
    const [convertedSql, convertedParams] = this.convertParams(sql, params);

    if (this.inTransaction && this.client) {
      await this.client.query(convertedSql, convertedParams);
    } else {
      await this.pool.query(convertedSql, convertedParams);
    }
  }

  async beginTransaction(): Promise<void> {
    if (!this.client) {
      this.client = await this.pool.connect();
    }
    await this.client.query("BEGIN");
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (this.client && this.inTransaction) {
      await this.client.query("COMMIT");
      this.inTransaction = false;
      this.client.release();
      this.client = undefined;
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (this.client && this.inTransaction) {
      await this.client.query("ROLLBACK");
      this.inTransaction = false;
      this.client.release();
      this.client = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return; // Already closed
    }
    this.closed = true;

    // Rollback any active transaction
    if (this.inTransaction && this.client) {
      await this.rollbackTransaction();
    }

    // Release client if still connected
    if (this.client) {
      this.client.release();
      this.client = undefined;
    }

    await this.pool.end();
  }
}
