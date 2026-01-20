/**
 * PostgreSQL connection implementation using PGLite (embedded PostgreSQL)
 *
 * NOTE: This is a test-only implementation. It depends on the `@electric-sql/pglite` library
 * and should not be included in the main library bundle.
 */

import {PGlite} from '@electric-sql/pglite';
import type {SQLDatabase} from './sql-database.js';
import type {DatabaseRow, SQLParams} from './types.js';

/**
 * PGLite connection wrapper that implements SqlConnection interface
 */
export class PGLiteSQLDatabase implements SQLDatabase {
  private db: PGlite;
  private inTransaction = false;
  private closed = false;
  private readyPromise: Promise<void>;

  constructor(dataDir = 'memory://') {
    // Use the fastest, most in-memory, least-durable config possible.
    // In memory, highest debug for fast error visibility, and disable all durability checks.
    this.db = new PGlite(dataDir, {
      relaxedDurability: true,
      // initialMemory: 128 * 1024 * 1024, // 128MB, can be tuned
      // debug: 5,
      // fs, extensions, wasmModule etc. can be passed through more options if needed
    });
    this.readyPromise = this.db.waitReady;
  }

  /**
   * Convert parameterized query from ? placeholders to PostgreSQL $1, $2, ... syntax
   */
  private convertParams(sql: string, params?: SQLParams): [string, SQLParams] {
    if (!params || params.length === 0) {
      return [sql, []];
    }

    let paramIndex = 1;
    const convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
    return [convertedSql, params];
  }

  async query(sql: string, params?: SQLParams): Promise<DatabaseRow[]> {
    await this.readyPromise;
    const [convertedSql, convertedParams] = this.convertParams(sql, params);

    const result = await this.db.query(convertedSql, convertedParams);

    // PGLite returns JSONB values as JavaScript primitives/objects
    // We need to convert ALL values to JSON strings for consistency with SQLite
    // This ensures that the query method can always JSON.parse them
    return (result.rows as DatabaseRow[]).map((row: DatabaseRow): DatabaseRow => {
      const convertedRow: DatabaseRow = {...row};
      // Convert value to JSON string if it exists
      const value = convertedRow.value;
      if (value !== null && value !== undefined) {
        // Always stringify to ensure consistency - PGLite JSONB returns
        // primitives directly, but we need them as JSON strings
        convertedRow.value = JSON.stringify(value);
      }
      // Handle BIGINT transaction IDs - PGLite can return them as strings or bigints
      // Convert to number for consistency
      const tx = convertedRow.tx;
      if (tx !== undefined) {
        if (typeof tx === 'bigint') {
          convertedRow.tx = Number(tx);
        } else if (typeof tx === 'string') {
          convertedRow.tx = Number.parseInt(tx, 10);
        }
      }
      const lastTx = convertedRow.last_tx;
      if (lastTx !== undefined) {
        if (typeof lastTx === 'bigint') {
          convertedRow.last_tx = Number(lastTx);
        } else if (typeof lastTx === 'string') {
          convertedRow.last_tx = Number.parseInt(lastTx, 10);
        }
      }
      return convertedRow;
    });
  }

  async execute(sql: string, params?: SQLParams): Promise<void> {
    await this.readyPromise;
    const [convertedSql, convertedParams] = this.convertParams(sql, params);
    await this.db.query(convertedSql, convertedParams);
  }

  async beginTransaction(): Promise<void> {
    if (this.inTransaction) {
      throw new Error('Transaction already in progress');
    }
    await this.readyPromise;
    await this.db.exec('BEGIN');
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No transaction in progress');
    }
    await this.readyPromise;
    await this.db.exec('COMMIT');
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No transaction in progress');
    }
    await this.readyPromise;
    await this.db.exec('ROLLBACK');
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
