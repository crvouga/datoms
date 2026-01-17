/**
 * PostgreSQL database implementation
 * Accepts a SqlConnection interface for PostgreSQL-compatible databases
 */

import type {
  DatalogQuery,
  QueryClause,
  QueryResult,
} from "../datalog/datalog.js";
import type { SQLDatabase } from "../sql-database/sql-database.js";
import type { DatabaseRow } from "../sql-database/types.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";
import { DatomDatabase, type Transaction } from "./datom-database.js";
import { isVariable, stripQuestionMark } from "./shared/datalog-helpers.js";
import { joinResults, project } from "./shared/query-helpers.js";

/**
 * PostgreSQL database implementation
 * Accepts a SqlDatabase that implements PostgreSQL-compatible SQL
 */
export class PostgreSQLDatomDatabase extends DatomDatabase {
  private connection: SQLDatabase;
  private tableName: string;
  protected initialized = false;
  private queryCount: number = 0;
  private transactionCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionTimeSum: number = 0;

  constructor(connection: SQLDatabase, tableName: string = "datoms") {
    super();
    this.connection = connection;
    this.tableName = tableName;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          entity TEXT NOT NULL,
          attribute TEXT NOT NULL,
          value JSONB NOT NULL,
          tx BIGINT NOT NULL,
          added BOOLEAN NOT NULL,
          PRIMARY KEY (entity, attribute, value, tx, added)
        )
      `;

      // PostgreSQL-optimized indexes
      // Note: INCLUDE clause not used for PGLite compatibility (requires PostgreSQL 11+)
      const indexes = [
        // Composite index for entity+attribute queries (most common pattern)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_entity_attr_tx ON ${this.tableName}(entity, attribute, tx DESC)`,
        // Composite index for attribute+value queries
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_attr_value_tx ON ${this.tableName}(attribute, value, tx DESC)`,
        // Partial index for added=true (most common case - only active datoms)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_active ON ${this.tableName}(entity, attribute, tx DESC) WHERE added = true`,
        // GIN index for JSONB value queries (containment, key existence, etc.)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_value_gin ON ${this.tableName} USING GIN (value)`,
        // Index on tx for transaction-based queries
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx DESC)`,
      ];

      await this.connection.execute(createTableSql);
      for (const indexSql of indexes) {
        await this.connection.execute(indexSql);
      }

      // Create transaction counter table
      const txTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName}_tx (
          id BIGINT PRIMARY KEY,
          last_tx BIGINT NOT NULL DEFAULT 0
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

      this.initialized = true;
    }
  }

  async close(): Promise<void> {
    if (this.connection.close) {
      await this.connection.close();
    }
    this.initialized = false;
  }

  protected async addDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();

    if (
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    ) {
      await this.connection.beginTransaction();
      try {
        await this.addDatomsInternal(datoms, tx);
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    } else {
      await this.addDatomsInternal(datoms, tx);
    }

    return tx;
  }

  protected async retractDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();

    if (
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    ) {
      await this.connection.beginTransaction();
      try {
        await this.retractDatomsInternal(datoms, tx);
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    } else {
      await this.retractDatomsInternal(datoms, tx);
    }

    return tx;
  }

  public async getRawDatoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions - connection adapter converts ? to $1, $2, etc.
    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      let value = options.value;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("value = ?::jsonb");
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Query without deduplication - return all matching datoms
    const sql = `
      SELECT 
        entity,
        attribute,
        value,
        tx,
        added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx ASC, entity ASC, attribute ASC
    `;

    const rows = await this.connection.query(sql, params);

    const reviveValue = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (value === "__UNDEFINED__") {
          return undefined;
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          return new Date(value);
        }
      }
      if (value === null) {
        return null;
      }
      if (value === undefined) {
        return undefined;
      }
      if (Array.isArray(value)) {
        return value.map(reviveValue);
      }
      if (typeof value === "object" && value !== null) {
        const revived: Record<string, unknown> = {};
        const valueObj = value as Record<string, unknown>;
        for (const key in valueObj) {
          revived[key] = reviveValue(valueObj[key]);
        }
        return revived;
      }
      return value;
    };

    return rows.map((row: DatabaseRow) => {
      let entity: EntityId = row.entity as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      const parsedValue: unknown =
        typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      const revivedValue = reviveValue(parsedValue) as Value;

      return [
        entity,
        String(row.attribute),
        revivedValue,
        Number(row.tx),
        Boolean(row.added),
      ] as Datom;
    });
  }

  protected async executeQuery(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();

    // Note: Validation is handled by the base class query() method
    // This method is also called by queryInternal() which bypasses validation
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions - connection adapter converts ? to $1, $2, etc.
    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      let value = options.value;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("value = ?::jsonb");
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    // Use DISTINCT ON to get latest datom per (entity, attribute, value) in SQL
    // This supports multi-valued attributes (multiple values per attribute)
    // PostgreSQL-specific: DISTINCT ON with ORDER BY for efficient latest-row-per-group
    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // We need to include retractions in DISTINCT ON to correctly determine the latest state.
    // We filter by added AFTER DISTINCT ON. This ensures that if a datom was added then retracted, the retraction wins.
    const combinedWhereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Use DISTINCT ON (entity, attribute, value) to support multi-valued attributes
    const distinctOnColumns = "entity, attribute, value";
    const orderByColumns = "entity, attribute, value, tx DESC";

    // Build the added filter for after DISTINCT ON
    // Default behavior: filter to only added datoms (exclude retracted)
    let addedFilterAfter = "";
    if (options.added === true || options.added === undefined) {
      addedFilterAfter = "WHERE added = true";
    } else if (options.added === false) {
      addedFilterAfter = "WHERE added = false";
    }

    const sql = `
      WITH latest_datoms AS (
        SELECT DISTINCT ON (${distinctOnColumns})
          entity, attribute, value, tx, added
        FROM ${this.tableName}
        ${combinedWhereClause}
        ORDER BY ${orderByColumns}
      )
      SELECT 
        entity,
        attribute,
        value,
        tx,
        added
      FROM latest_datoms
      ${addedFilterAfter}
      ORDER BY
        CASE 
          WHEN entity ~ '^-{0,1}[0-9]+$' THEN entity::BIGINT 
          ELSE 0 
        END,
        attribute
      ${limitClause}
      ${offsetClause}
    `;

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.connection.query(sql, params);

    const reviveValue = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (value === "__UNDEFINED__") {
          return undefined;
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          return new Date(value);
        }
      }
      if (value === null) {
        return null;
      }
      if (value === undefined) {
        return undefined;
      }
      if (Array.isArray(value)) {
        return value.map(reviveValue);
      }
      if (typeof value === "object" && value !== null) {
        const revived: Record<string, unknown> = {};
        const valueObj = value as Record<string, unknown>;
        for (const key in valueObj) {
          revived[key] = reviveValue(valueObj[key]);
        }
        return revived;
      }
      return value;
    };

    return rows.map((row: DatabaseRow) => {
      let entity: EntityId = row.entity as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      // PostgreSQL JSONB returns as parsed object, but connection adapter stringifies it
      // So we still need to parse
      const parsedValue: unknown =
        typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      const revivedValue = reviveValue(parsedValue) as Value;

      return [
        entity,
        String(row.attribute),
        revivedValue,
        Number(row.tx),
        Boolean(row.added),
      ] as Datom;
    });
  }

  public async executeAsOfQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this.ensureInitialized();

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions
    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      let value = options.value;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("value = ?::jsonb");
      params.push(JSON.stringify(value));
    }

    // Merge options.tx with txId: use minimum of both if options.tx is specified
    const maxTx = options.tx !== undefined ? Math.min(options.tx, txId) : txId;
    conditions.push("tx <= ?");
    params.push(maxTx);

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // Use DISTINCT ON (entity, attribute) to deduplicate by entity-attribute pair
    // This keeps the latest value per attribute (asOf semantics)
    const sql = `
      SELECT DISTINCT ON (entity, attribute)
        entity, attribute, value, tx, added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY entity, attribute, tx DESC
    `;

    // Filter to only added datoms after DISTINCT ON
    const finalSql = `
      WITH latest_datoms AS (${sql})
      SELECT 
        entity,
        attribute,
        value,
        tx,
        added
      FROM latest_datoms
      WHERE added = true
      ORDER BY
        CASE 
          WHEN entity ~ '^-{0,1}[0-9]+$' THEN entity::BIGINT 
          ELSE 0 
        END,
        attribute
      ${limitClause}
      ${offsetClause}
    `;

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.connection.query(finalSql, params);
    return this.mapRowsToDatoms(rows);
  }

  public async executeHistoryQuery(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions
    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      let value = options.value;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("value = ?::jsonb");
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // History query: no deduplication, include all datoms including retracted
    const sql = `
      SELECT 
        entity,
        attribute,
        value,
        tx,
        added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx ASC, entity ASC, attribute ASC
      ${limitClause}
      ${offsetClause}
    `;

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.connection.query(sql, params);
    return this.mapRowsToDatoms(rows);
  }

  public async executeSinceQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this.ensureInitialized();

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions
    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      let value = options.value;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("value = ?::jsonb");
      params.push(JSON.stringify(value));
    }

    // Filter to only datoms with tx > txId
    conditions.push("tx > ?");
    params.push(txId);

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // Use DISTINCT ON (entity, attribute, value) for normal deduplication
    const sql = `
      SELECT DISTINCT ON (entity, attribute, value)
        entity, attribute, value, tx, added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY entity, attribute, value, tx DESC
    `;

    // Filter to only added datoms after DISTINCT ON
    const finalSql = `
      WITH latest_datoms AS (${sql})
      SELECT 
        entity,
        attribute,
        value,
        tx,
        added
      FROM latest_datoms
      WHERE added = true
      ORDER BY
        CASE 
          WHEN entity ~ '^-{0,1}[0-9]+$' THEN entity::BIGINT 
          ELSE 0 
        END,
        attribute
      ${limitClause}
      ${offsetClause}
    `;

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.connection.query(finalSql, params);
    return this.mapRowsToDatoms(rows);
  }

  /**
   * Helper method to map database rows to Datom objects
   * Reused across query methods
   */
  private mapRowsToDatoms(rows: DatabaseRow[]): Datom[] {
    const reviveValue = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (value === "__UNDEFINED__") {
          return undefined;
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          return new Date(value);
        }
      }
      if (value === null) {
        return null;
      }
      if (value === undefined) {
        return undefined;
      }
      if (Array.isArray(value)) {
        return value.map(reviveValue);
      }
      if (typeof value === "object" && value !== null) {
        const revived: Record<string, unknown> = {};
        const valueObj = value as Record<string, unknown>;
        for (const key in valueObj) {
          revived[key] = reviveValue(valueObj[key]);
        }
        return revived;
      }
      return value;
    };

    return rows.map((row: DatabaseRow) => {
      let entity: EntityId = row.entity as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      const parsedValue: unknown =
        typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      const revivedValue = reviveValue(parsedValue) as Value;

      return [
        entity,
        String(row.attribute),
        revivedValue,
        Number(row.tx),
        Boolean(row.added),
      ] as Datom;
    });
  }

  async query(query: DatalogQuery): Promise<QueryResult> {
    await this.ensureInitialized();
    if (query.where.length === 0) {
      return [];
    }

    // Note: Datalog queries use the optimized query() method which leverages
    // PostgreSQL DISTINCT ON and SQL-level filtering/sorting for performance.
    // Future optimization: For simple multi-clause queries, could use SQL JOINs
    // directly instead of in-memory joins, but current approach handles complex
    // datalog semantics correctly.

    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause);

    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause);
      results = joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    const projected = project(results, query.find, query.where);

    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];

          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    if (query.limit) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  protected async executeTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    _isolationLevel?: import("../types.js").TransactionIsolationLevel
  ): Promise<T> {
    // Note: PostgreSQL isolation level support would require SET TRANSACTION ISOLATION LEVEL
    // For now, we use the database default (READ COMMITTED)
    await this.ensureInitialized();

    if (
      !this.connection.beginTransaction ||
      !this.connection.commitTransaction ||
      !this.connection.rollbackTransaction
    ) {
      throw new Error(
        "Transaction support requires beginTransaction, commitTransaction, and rollbackTransaction methods"
      );
    }

    const txId = await this.getNextTransactionId();
    const transaction = this.createTransaction(txId);

    await this.connection.beginTransaction();
    try {
      const result = await callback(transaction);
      // Apply pending changes before committing
      const txWithCommit = transaction as Transaction & {
        commit: () => Promise<void>;
      };
      await txWithCommit.commit();
      await this.connection.commitTransaction();
      return result;
    } catch (error) {
      await this.connection.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Clean up tables for test isolation
   * This method can be called before each test to ensure a clean state
   * @internal - This method is for internal testing use only and should not be called in production
   */
  protected async cleanUp(): Promise<void> {
    await this.ensureInitialized();
    await this.connection.execute(
      `TRUNCATE TABLE ${this.tableName}, ${this.tableName}_tx RESTART IDENTITY CASCADE`
    );
    // Re-initialize transaction counter after truncate
    const initTxSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      SELECT 1, 0
      WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
    `;
    await this.connection.execute(initTxSql);
  }

  private async getNextTransactionId(): Promise<TransactionId> {
    // PostgreSQL-optimized: Use INSERT ... ON CONFLICT ... UPDATE ... RETURNING
    // This combines initialization, update, and retrieval into a single atomic operation
    // The ON CONFLICT ensures thread-safety, and RETURNING gets the new value in one query
    const sql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      VALUES (1, 0)
      ON CONFLICT (id) 
      DO UPDATE SET last_tx = ${this.tableName}_tx.last_tx + 1
      RETURNING last_tx
    `;

    const result = await this.connection.query(sql);
    if (!result || result.length === 0) {
      throw new Error("Transaction counter row not found after update");
    }
    const row = result[0] as Record<string, unknown>;
    return Number(row.last_tx);
  }

  private async addDatomsInternal(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `;

    const params = datoms.flatMap((d) => {
      let value = d[2];
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      return [String(d[0]), String(d[1]), JSON.stringify(value), tx, true];
    });

    await this.connection.execute(sql, params);
  }

  private async retractDatomsInternal(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `;

    const params = datoms.flatMap((d) => {
      let value = d[2];
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      return [String(d[0]), String(d[1]), JSON.stringify(value), tx, false];
    });

    await this.connection.execute(sql, params);
  }

  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value | Attribute>[]> {
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Datalog queries manage their own limiting via joins, so bypass validation
    const queryOptions: QueryOptions = {
      ...(entity !== undefined && { entity }),
      ...(attribute !== undefined && { attribute }),
      ...(value !== undefined && { value }),
    };

    const datoms = await this.queryInternal(queryOptions);

    return datoms.map((datom: Datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom[0];
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom[1];
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom[2];
      }
      return result;
    });
  }

  /**
   * Get metadata associated with a transaction
   * Default implementation returns undefined (metadata storage not implemented)
   * Override onTransactionMetadata and this method to support metadata storage
   */
  async getTransactionMetadata(
    _txId: TransactionId
  ): Promise<Record<string, unknown> | undefined> {
    // Default: no metadata storage
    return undefined;
  }

  async getLatestTransaction(): Promise<TransactionId> {
    await this.ensureInitialized();
    const sql = `SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1`;
    const result = await this.connection.query(sql);
    if (!result || result.length === 0) {
      // No transactions yet
      return 0;
    }
    const row = result[0] as Record<string, unknown>;
    return Number(row.last_tx);
  }

  protected async recordQueryMetrics(duration: number): Promise<void> {
    this.queryCount++;
    this.queryTimeSum += duration;
  }

  protected async recordTransactionMetrics(duration: number): Promise<void> {
    this.transactionCount++;
    this.transactionTimeSum += duration;
  }

  protected async getDetailedStats(): Promise<
    Partial<
      Pick<
        import("../types.js").DatabaseStats,
        "totalDatoms" | "totalEntities" | "queryMetrics" | "transactionMetrics"
      >
    >
  > {
    const stats: Partial<import("../types.js").DatabaseStats> = {};

    // Count total datoms (only added ones, latest version)
    // PostgreSQL-specific: Use DISTINCT ON for efficient latest-row-per-group
    const countSql = `
      WITH latest_datoms AS (
        SELECT DISTINCT ON (entity, attribute, value)
          entity, attribute, value, tx, added
        FROM ${this.tableName}
        ORDER BY entity, attribute, value, tx DESC
      )
      SELECT COUNT(*) as count
      FROM latest_datoms
      WHERE added = true
    `;
    const countResult = await this.connection.query(countSql);
    const countRow = countResult[0] as Record<string, unknown> | undefined;
    const countValue = countRow?.count ?? 0;
    stats.totalDatoms =
      typeof countValue === "string"
        ? parseInt(countValue, 10)
        : Number(countValue);

    // Count unique entities
    const entitySql = `
      SELECT COUNT(DISTINCT entity) as count
      FROM ${this.tableName}
      WHERE added = true
    `;
    const entityResult = await this.connection.query(entitySql);
    const entityRow = entityResult[0] as Record<string, unknown> | undefined;
    const entityCountValue = entityRow?.count ?? 0;
    stats.totalEntities =
      typeof entityCountValue === "string"
        ? parseInt(entityCountValue, 10)
        : Number(entityCountValue);

    // Add query metrics if available
    if (this.queryCount > 0) {
      stats.queryMetrics = {
        totalQueries: this.queryCount,
        averageQueryTime: this.queryTimeSum / this.queryCount / 1000, // Convert to seconds
      };
    }

    // Add transaction metrics if available
    if (this.transactionCount > 0) {
      stats.transactionMetrics = {
        averageTransactionTime:
          this.transactionTimeSum / this.transactionCount / 1000, // Convert to seconds
      };
    }

    return stats;
  }

  /**
   * PostgreSQL transaction implementation
   * Tracks pending changes and merges them with queries
   */
  private createTransaction(txId: TransactionId): Transaction {
    return new PostgreSQLTransaction(
      this.connection,
      this.tableName,
      txId,
      this
    );
  }
}

/**
 * PostgreSQL transaction implementation
 * Tracks pending changes and merges them with queries
 */
class PostgreSQLTransaction implements Transaction {
  private connection: SQLDatabase;
  private tableName: string;
  private txId: TransactionId;
  private db: PostgreSQLDatomDatabase;
  private pendingAdds: Datom[] = [];
  private pendingRetracts: Datom[] = [];

  constructor(
    connection: SQLDatabase,
    tableName: string,
    txId: TransactionId,
    db: PostgreSQLDatomDatabase
  ) {
    this.connection = connection;
    this.tableName = tableName;
    this.txId = txId;
    this.db = db;
  }

  getTransactionId(): TransactionId {
    return this.txId;
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Query committed data (bypass validation since transactions manage their own constraints)
    const committed = await this.db._queryInternalForTransaction(options);

    // Merge with pending changes
    const pending = this.mergePendingChanges(committed, options);
    return pending;
  }

  async query(query: DatalogQuery): Promise<QueryResult> {
    // Use the database's query but with transaction-aware query
    // We need to override executeClause to use transaction-aware query
    return this.executeDatalogWithTransaction(query);
  }

  async transact(ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }): Promise<void> {
    if (ops.add && ops.add.length > 0) {
      for (const datom of ops.add) {
        const d: Datom = [datom[0], datom[1], datom[2], this.txId, true];
        this.pendingAdds.push(d);
      }
    }
    if (ops.retract && ops.retract.length > 0) {
      for (const datom of ops.retract) {
        const key = `${String(datom[0])}|${String(datom[1])}|${String(datom[2])}`;

        // Remove from pending adds if it was added in this transaction
        this.pendingAdds = this.pendingAdds.filter((d) => {
          const dKey = `${String(d[0])}|${String(d[1])}|${String(d[2])}`;
          return dKey !== key;
        });

        // Add to pending retracts
        const d: Datom = [datom[0], datom[1], datom[2], this.txId, false];
        this.pendingRetracts.push(d);
      }
    }
  }

  async commit(): Promise<void> {
    // Apply all pending changes to the database
    // We'll apply these directly via SQL since we're already in a transaction
    if (this.pendingAdds.length > 0) {
      const placeholders = this.pendingAdds
        .map(() => "(?, ?, ?, ?, ?)")
        .join(", ");
      const sql = `
        INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;

      const params = this.pendingAdds.flatMap((d) => {
        let value = d[2];
        if (value === undefined) {
          value = "__UNDEFINED__";
        }
        return [
          String(d[0]),
          String(d[1]),
          JSON.stringify(value),
          this.txId,
          true,
        ];
      });

      await this.connection.execute(sql, params);
    }
    if (this.pendingRetracts.length > 0) {
      const placeholders = this.pendingRetracts
        .map(() => "(?, ?, ?, ?, ?)")
        .join(", ");
      const sql = `
        INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;

      const params = this.pendingRetracts.flatMap((d) => {
        let value = d[2];
        if (value === undefined) {
          value = "__UNDEFINED__";
        }
        return [
          String(d[0]),
          String(d[1]),
          JSON.stringify(value),
          this.txId,
          false,
        ];
      });

      await this.connection.execute(sql, params);
    }
  }

  private mergePendingChanges(
    committed: Datom[],
    options: QueryOptions
  ): Datom[] {
    // Create a map of committed datoms by (entity, attribute, value)
    const committedMap = new Map<string, Datom>();
    for (const datom of committed) {
      const key = `${String(datom[0])}|${String(datom[1])}|${String(datom[2])}`;
      const existing = committedMap.get(key);
      if (!existing || datom[3] > existing[3]) {
        committedMap.set(key, datom);
      }
    }

    // Apply pending retracts (remove matching datoms)
    for (const retract of this.pendingRetracts) {
      const key = `${String(retract[0])}|${String(
        retract[1]
      )}|${String(retract[2])}`;
      committedMap.delete(key);
    }

    // Apply pending adds (add or update datoms)
    for (const add of this.pendingAdds) {
      const key = `${String(add[0])}|${String(add[1])}|${String(add[2])}`;
      committedMap.set(key, add);
    }

    let results = Array.from(committedMap.values());

    // Apply filters from options
    if (options.entity !== undefined) {
      results = results.filter((d) => d[0] === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d[1] === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d[2] === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d[3] === options.tx);
    }

    // Handle added filter
    if (options.added === undefined || options.added === true) {
      results = results.filter((d) => d[4]);
    } else if (options.added === false) {
      results = results.filter((d) => !d[4]);
    }

    // Sort by entity, then attribute
    results.sort((a, b) => {
      let entityA: number;
      if (typeof a[0] === "number") {
        entityA = a[0];
      } else {
        const entityStr = String(a[0]);
        entityA = /^-?\d+$/.test(entityStr) ? parseInt(entityStr, 10) : 0;
      }

      let entityB: number;
      if (typeof b[0] === "number") {
        entityB = b[0];
      } else {
        const entityStr = String(b[0]);
        entityB = /^-?\d+$/.test(entityStr) ? parseInt(entityStr, 10) : 0;
      }

      if (entityA !== entityB) {
        return entityA - entityB;
      }
      return String(a[1]).localeCompare(String(b[1]));
    });

    // Apply pagination
    const offset = options.offset ?? 0;
    const paginated = options.limit
      ? results.slice(offset, offset + options.limit)
      : results.slice(offset);

    return paginated;
  }

  private async executeDatalogWithTransaction(
    query: DatalogQuery
  ): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause);

    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause);
      results = joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    const projected = project(results, query.find, query.where);

    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];

          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    if (query.limit) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value | Attribute>[]> {
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Use transaction's query method to see uncommitted changes
    const queryOptions: QueryOptions = {
      ...(entity !== undefined && { entity }),
      ...(attribute !== undefined && { attribute }),
      ...(value !== undefined && { value }),
    };

    const datoms = await this.datoms(queryOptions);

    return datoms.map((datom: Datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom[0];
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom[1];
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom[2];
      }
      return result;
    });
  }
}
