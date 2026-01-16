/**
 * SQL storage backend interface and base implementation
 */

import type {
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
} from "../types.js";
import type { StorageBackend } from "./backend.js";

/**
 * SQL connection interface that abstracts different SQL libraries
 */
export interface SqlConnection {
  query(sql: string, params?: any[]): Promise<any[]>;
  execute(sql: string, params?: any[]): Promise<void>;
  beginTransaction?(): Promise<void>;
  commitTransaction?(): Promise<void>;
  rollbackTransaction?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Base SQL storage backend implementation
 * Can be extended for specific SQL databases (PostgreSQL, MySQL, SQLite, etc.)
 */
export abstract class SqlBackend implements StorageBackend {
  protected connection: SqlConnection;
  protected tableName: string;

  constructor(connection: SqlConnection, tableName: string = "datoms") {
    this.connection = connection;
    this.tableName = tableName;
  }

  /**
   * Get the SQL dialect-specific syntax
   */
  protected abstract getDialect(): SqlDialect;

  /**
   * Get the SQL type for a value
   */
  protected abstract getValueType(value: any): string;

  async initialize(): Promise<void> {
    const dialect = this.getDialect();
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        entity ${dialect.textType} NOT NULL,
        attribute ${dialect.textType} NOT NULL,
        value ${dialect.jsonType} NOT NULL,
        tx ${dialect.integerType} NOT NULL,
        added ${dialect.booleanType} NOT NULL,
        PRIMARY KEY (entity, attribute, value, tx, added)
      )
    `;

    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_entity ON ${this.tableName}(entity)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_attribute ON ${this.tableName}(attribute)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx)`,
    ];

    await this.connection.execute(createTableSql);
    for (const indexSql of indexes) {
      await this.connection.execute(indexSql);
    }

    // Create transaction counter table
    const txTableSql = `
      CREATE TABLE IF NOT EXISTS ${this.tableName}_tx (
        id ${dialect.integerType} PRIMARY KEY,
        last_tx ${dialect.integerType} NOT NULL DEFAULT 0
      )
    `;
    await this.connection.execute(txTableSql);

    // Initialize transaction counter if needed
    const initTxSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      SELECT 1, 0
      WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
    `;
    await this.connection.execute(initTxSql);
  }

  async close(): Promise<void> {
    if (this.connection.close) {
      await this.connection.close();
    }
  }

  async getNextTransactionId(): Promise<TransactionId> {
    const dialect = this.getDialect();
    const updateSql = `
      UPDATE ${this.tableName}_tx
      SET last_tx = last_tx + 1
      WHERE id = 1
    `;
    await this.connection.execute(updateSql);

    const selectSql = `
      SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1
    `;
    const result = await this.connection.query(selectSql);
    return result[0].last_tx;
  }

  async addDatoms(datoms: DatomInput[], tx: TransactionId): Promise<void> {
    if (datoms.length === 0) return;

    const dialect = this.getDialect();
    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ${dialect.onConflict || ""}
    `;

    const params = datoms.flatMap((d) => [
      String(d.entity),
      String(d.attribute),
      JSON.stringify(d.value),
      tx,
      true,
    ]);

    await this.connection.execute(sql, params);
  }

  async retractDatoms(datoms: DatomInput[], tx: TransactionId): Promise<void> {
    if (datoms.length === 0) return;

    const dialect = this.getDialect();
    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ${dialect.onConflict || ""}
    `;

    const params = datoms.flatMap((d) => [
      String(d.entity),
      String(d.attribute),
      JSON.stringify(d.value),
      tx,
      false,
    ]);

    await this.connection.execute(sql, params);
  }

  async queryDatoms(options: QueryOptions): Promise<Datom[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      conditions.push("value = ?");
      params.push(JSON.stringify(options.value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }
    if (options.added !== undefined) {
      conditions.push("added = ?");
      params.push(options.added);
    } else {
      // Default to only added datoms
      conditions.push("added = ?");
      params.push(true);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset ? `OFFSET ${options.offset}` : "";

    const sql = `
      SELECT entity, attribute, value, tx, added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx DESC
      ${limitClause}
      ${offsetClause}
    `;

    const rows = await this.connection.query(sql, params);
    return rows.map((row: any) => ({
      entity: row.entity,
      attribute: row.attribute,
      value: JSON.parse(row.value),
      tx: row.tx,
      added: row.added,
    }));
  }

  async getEntityDatoms(entity: EntityId): Promise<Datom[]> {
    return this.queryDatoms({ entity, added: true });
  }

  supportsTransactions(): boolean {
    return !!(
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    );
  }

  async beginTransaction(): Promise<void> {
    if (this.connection.beginTransaction) {
      await this.connection.beginTransaction();
    }
  }

  async commitTransaction(): Promise<void> {
    if (this.connection.commitTransaction) {
      await this.connection.commitTransaction();
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (this.connection.rollbackTransaction) {
      await this.connection.rollbackTransaction();
    }
  }
}

/**
 * SQL dialect-specific syntax
 */
export interface SqlDialect {
  textType: string;
  integerType: string;
  booleanType: string;
  jsonType: string;
  onConflict?: string;
}

/**
 * PostgreSQL dialect
 */
export const postgresDialect: SqlDialect = {
  textType: "TEXT",
  integerType: "BIGINT",
  booleanType: "BOOLEAN",
  jsonType: "JSONB",
  onConflict: "ON CONFLICT DO NOTHING",
};

/**
 * SQLite dialect
 */
export const sqliteDialect: SqlDialect = {
  textType: "TEXT",
  integerType: "INTEGER",
  booleanType: "INTEGER", // SQLite uses INTEGER for booleans
  jsonType: "TEXT", // SQLite stores JSON as TEXT
  onConflict: "ON CONFLICT DO NOTHING",
};

/**
 * MySQL dialect
 */
export const mysqlDialect: SqlDialect = {
  textType: "VARCHAR(255)",
  integerType: "BIGINT",
  booleanType: "BOOLEAN",
  jsonType: "JSON",
  onConflict: "ON DUPLICATE KEY UPDATE entity=entity", // MySQL syntax
};
