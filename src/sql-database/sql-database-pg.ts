/**
 * PostgreSQL connection implementation using node-postgres (pg)
 *
 * NOTE: This is a test-only implementation. It depends on the `pg` library
 * and should not be included in the main library bundle.
 */

import {Pool} from 'pg';
import type {PoolClient} from 'pg';
import type {SQLDatabase} from './sql-database.js';
import type {DatabaseRow, SQLParams} from './types.js';

/**
 * SSL configuration for PostgreSQL connection
 */
type SSLConfig =
  | false
  | {
      rejectUnauthorized?: boolean;
      ca?: string;
    };

/**
 * Result of parsing connection string for SSL config
 */
interface ParsedConnectionConfig {
  connectionString: string;
  ssl?: SSLConfig;
}

/**
 * Parse connection string and extract SSL configuration
 */
function parseSSLConfig(connectionString: string): ParsedConnectionConfig {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get('sslmode');
  const sslRootCert = url.searchParams.get('sslrootcert');

  // Remove SSL params from URL as we'll handle them in Pool config
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  const cleanConnectionString = url.toString();

  // Configure SSL based on parameters
  if (sslMode === 'require' || sslMode === 'verify-full' || sslMode === 'verify-ca') {
    const sslConfig: SSLConfig = {
      rejectUnauthorized: sslMode === 'verify-full' || sslMode === 'verify-ca',
    };

    // Handle sslrootcert=system - use Node's default CA certificates
    // When sslrootcert is "system" or not provided, use default CA store
    if (sslRootCert && sslRootCert !== 'system') {
      // If a specific cert file is provided, use it
      sslConfig.ca = sslRootCert;
    }
    // If sslrootcert=system or not specified, don't set ca property
    // This allows Node.js to use its default CA certificates

    return {
      connectionString: cleanConnectionString,
      ssl: sslConfig,
    };
  }

  // No SSL or disable SSL
  if (sslMode === 'disable') {
    return {
      connectionString: cleanConnectionString,
      ssl: false,
    };
  }

  return {
    connectionString: cleanConnectionString,
  };
}

/**
 * PostgreSQL connection wrapper that implements SqlConnection interface
 */
export class PgSQLDatabase implements SQLDatabase {
  private pool: Pool;
  private client?: PoolClient;
  private inTransaction = false;
  private closed = false;

  constructor(connectionString: string) {
    const parsed = parseSSLConfig(connectionString);
    const poolConfig: {
      connectionString: string;
      max: number;
      ssl?: SSLConfig;
    } = {
      connectionString: parsed.connectionString,
      max: 1, // Use single connection for test isolation
    };
    if (parsed.ssl !== undefined) {
      poolConfig.ssl = parsed.ssl;
    }
    this.pool = new Pool(poolConfig);
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
    const [convertedSql, convertedParams] = this.convertParams(sql, params);

    let result: {rows: DatabaseRow[]};
    if (this.inTransaction && this.client) {
      result = await this.client.query(convertedSql, convertedParams);
    } else {
      result = await this.pool.query(convertedSql, convertedParams);
    }

    // PostgreSQL returns JSONB values as JavaScript primitives/objects
    // We need to convert ALL values to JSON strings for consistency with SQLite
    // This ensures that the query method can always JSON.parse them
    return result.rows.map((row: DatabaseRow): DatabaseRow => {
      const convertedRow: DatabaseRow = {...row};
      // Convert value to JSON string if it exists
      const value = convertedRow.value;
      if (value !== null && value !== undefined) {
        // Always stringify to ensure consistency - PostgreSQL JSONB returns
        // primitives directly, but we need them as JSON strings
        convertedRow.value = JSON.stringify(value);
      }
      // Handle BIGINT transaction IDs - PostgreSQL can return them as strings or bigints
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
    await this.client.query('BEGIN');
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    if (this.client && this.inTransaction) {
      await this.client.query('COMMIT');
      this.inTransaction = false;
      this.client.release();
      this.client = undefined;
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (this.client && this.inTransaction) {
      await this.client.query('ROLLBACK');
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
