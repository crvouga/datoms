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

import { DatomDatabase, QueryError } from "./datom-database.js";
import type { ReadContext } from "./hook/hook.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "./shared/datalog-helpers.js";
import { joinResults, project } from "./shared/query-helpers.js";
import {
  aggregationToSQL,
  checkSQLAggregations,
} from "./shared/aggregations/shared/helpers.js";
import { parseAggregation } from "./shared/aggregations/index.js";
import { applyAggregations } from "./shared/aggregations/index.js";

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
      // Create enum type for op column (handle error if already exists)
      try {
        await this.connection.execute(`
          CREATE TYPE datom_op AS ENUM ('assert', 'retract')
        `);
      } catch (error) {
        // Type already exists, ignore error
        // PostgreSQL doesn't support IF NOT EXISTS for CREATE TYPE
      }

      const createTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          e TEXT NOT NULL,
          a TEXT NOT NULL,
          v JSONB NOT NULL,
          tx BIGINT NOT NULL,
          op datom_op NOT NULL,
          PRIMARY KEY (e, a, v, tx, op)
        )
      `;

      // PostgreSQL-optimized indexes
      // Note: INCLUDE clause not used for PGLite compatibility (requires PostgreSQL 11+)
      const indexes = [
        // Composite index for entity+attribute queries (most common pattern)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e_a_tx ON ${this.tableName}(e, a, tx DESC)`,
        // Composite index for attribute+value queries
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_v_tx ON ${this.tableName}(a, v, tx DESC)`,
        // Partial index for op='assert' (most common case - only active datoms)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_active ON ${this.tableName}(e, a, tx DESC) WHERE op = 'assert'`,
        // GIN index for JSONB value queries (containment, key existence, etc.)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_v_gin ON ${this.tableName} USING GIN (v)`,
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

  protected async subDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();

    if (
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    ) {
      await this.connection.beginTransaction();
      try {
        await this.subDatomsInternal(datoms, tx);
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    } else {
      await this.subDatomsInternal(datoms, tx);
    }

    return tx;
  }

  public async getRawDatoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions - connection adapter converts ? to $1, $2, etc.
    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("v = ?::jsonb");
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
        e,
        a,
        v,
        tx,
        op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx ASC, e ASC, a ASC
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
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      // PostgreSQL JSONB returns as parsed object, but connection adapter may stringify it
      // Handle both cases: already parsed or string that needs parsing
      let parsedValue: unknown = row.v;
      if (typeof row.v === "string") {
        // Try to parse as JSON, but if it fails, use the string as-is
        // This handles cases where JSONB returns simple strings directly
        try {
          parsedValue = JSON.parse(row.v);
        } catch {
          // Not valid JSON, use as plain string
          parsedValue = row.v;
        }
      }
      const revivedValue = reviveValue(parsedValue) as Value;

      return {
        e: entity,
        a: String(row.a),
        v: revivedValue,
        tx: Number(row.tx),
        op:
          typeof row.op === "string" && row.op === "assert"
            ? "assert"
            : "retract",
      };
    });
  }

  protected async executeQuery(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();

    // Note: Validation is handled by the base class query() method
    // This method is also called by queryInternal() which bypasses validation
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions - connection adapter converts ? to $1, $2, etc.
    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("v = ?::jsonb");
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    // Use DISTINCT ON to get latest datom per (e, a, v) in SQL
    // This supports multi-valued attributes (multiple values per attribute)
    // PostgreSQL-specific: DISTINCT ON with ORDER BY for efficient latest-row-per-group
    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // We need to include retractions in DISTINCT ON to correctly determine the latest state.
    // We filter by op AFTER DISTINCT ON. This ensures that if a datom was asserted then retracted, the retraction wins.
    const combinedWhereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Use DISTINCT ON (e, a, v) to support multi-valued attributes
    const distinctOnColumns = "e, a, v";
    const orderByColumns = "e, a, v, tx DESC";

    // Build the op filter for after DISTINCT ON
    // Default behavior: filter to only add datoms (exclude sub)
    let opFilterAfter = "";
    if (options.op === undefined || options.op === "assert") {
      opFilterAfter = "WHERE op = 'assert'";
    } else if (options.op === "retract") {
      opFilterAfter = "WHERE op = 'retract'";
    }

    const sql = `
      WITH latest_datoms AS (
        SELECT DISTINCT ON (${distinctOnColumns})
          e, a, v, tx, op
        FROM ${this.tableName}
        ${combinedWhereClause}
        ORDER BY ${orderByColumns}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM latest_datoms
      ${opFilterAfter}
      ORDER BY
        CASE 
          WHEN e ~ '^-{0,1}[0-9]+$' THEN e::BIGINT 
          ELSE 0 
        END,
        a
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
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      // PostgreSQL JSONB returns as parsed object, but connection adapter may stringify it
      // Handle both cases: already parsed or string that needs parsing
      let parsedValue: unknown = row.v;
      if (typeof row.v === "string") {
        // Try to parse as JSON, but if it fails, use the string as-is
        // This handles cases where JSONB returns simple strings directly
        try {
          parsedValue = JSON.parse(row.v);
        } catch {
          // Not valid JSON, use as plain string
          parsedValue = row.v;
        }
      }
      const revivedValue = reviveValue(parsedValue) as Value;

      return {
        e: entity,
        a: String(row.a),
        v: revivedValue,
        tx: Number(row.tx),
        op:
          typeof row.op === "string" && row.op === "assert"
            ? "assert"
            : "retract",
      };
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
    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("v = ?::jsonb");
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

    // Use DISTINCT ON (e, a) to deduplicate by entity-attribute pair
    // This keeps the latest value per attribute (asOf semantics)
    const sql = `
      SELECT DISTINCT ON (e, a)
        e, a, v, tx, op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY e, a, tx DESC
    `;

    // Filter to only add datoms after DISTINCT ON
    const finalSql = `
      WITH latest_datoms AS (${sql})
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM latest_datoms
      WHERE op = 'assert'
      ORDER BY
        CASE 
          WHEN e ~ '^-{0,1}[0-9]+$' THEN e::BIGINT 
          ELSE 0 
        END,
        a
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
    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("v = ?::jsonb");
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

    // History query: no deduplication, include all datoms including sub
    const sql = `
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx ASC, e ASC, a ASC
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
    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      conditions.push("v = ?::jsonb");
      params.push(JSON.stringify(value));
    }

    // Filter to only datoms with tx > txId
    conditions.push("tx > ?");
    params.push(txId);

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // Use DISTINCT ON (e, a, v) for normal deduplication
    const sql = `
      SELECT DISTINCT ON (e, a, v)
        e, a, v, tx, op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY e, a, v, tx DESC
    `;

    // Filter to only add datoms after DISTINCT ON
    const finalSql = `
      WITH latest_datoms AS (${sql})
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM latest_datoms
      WHERE op = 'assert'
      ORDER BY
        CASE 
          WHEN e ~ '^-{0,1}[0-9]+$' THEN e::BIGINT 
          ELSE 0 
        END,
        a
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
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      // PostgreSQL JSONB returns as parsed object, but connection adapter may stringify it
      // Handle both cases: already parsed or string that needs parsing
      let parsedValue: unknown = row.v;
      if (typeof row.v === "string") {
        // Try to parse as JSON, but if it fails, use the string as-is
        // This handles cases where JSONB returns simple strings directly
        try {
          parsedValue = JSON.parse(row.v);
        } catch {
          // Not valid JSON, use as plain string
          parsedValue = row.v;
        }
      }
      const revivedValue = reviveValue(parsedValue) as Value;

      return {
        e: entity,
        a: String(row.a),
        v: revivedValue,
        tx: Number(row.tx),
        op:
          typeof row.op === "string" && row.op === "assert"
            ? "assert"
            : "retract",
      };
    });
  }

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    await this.ensureInitialized();

    // Create read context
    const ctx: ReadContext = {
      db: this,
      ...(context || {}),
    };

    // Run before-read hooks
    const beforeResult = await this.hooks.runBeforeRead(query, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError("Query blocked by hooks", beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query;

    if (modifiedQuery.where.length === 0) {
      return [];
    }

    // Extract all datoms from all clauses for afterRead hooks
    const allDatomsSet = new Set<string>();
    const allDatoms: Datom[] = [];

    for (const clause of modifiedQuery.where) {
      if (!isQueryPattern(clause)) {
        continue;
      }
      const clauseDatoms = await this.executeClauseAsDatoms(clause);
      for (const datom of clauseDatoms) {
        const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
        if (!allDatomsSet.has(key)) {
          allDatomsSet.add(key);
          allDatoms.push(datom);
        }
      }
    }

    // Run after-read hooks
    const afterResult = await this.hooks.runAfterRead(allDatoms, ctx);

    if (afterResult.errors && afterResult.errors.length > 0) {
      throw new QueryError(
        "Query blocked by after-read hooks",
        afterResult.errors
      );
    }

    // Check if we have aggregations - if so, use SQL query building
    const aggCheck = checkSQLAggregations(modifiedQuery.find, "postgresql");
    const hasAggs = aggCheck.hasAggregations;
    const allAggsSupported = aggCheck.allSupported;

    // If we have unsupported aggregations, use in-memory approach (for both single and multi-clause)
    if (hasAggs && !allAggsSupported) {
      // Use in-memory joins and aggregations
      const firstClause = modifiedQuery.where[0];
      const firstResults = await this.executeClauseWithFilteredDatoms(
        firstClause,
        afterResult.datoms
      );

      let results = firstResults;
      for (let i = 1; i < modifiedQuery.where.length; i++) {
        const clause = modifiedQuery.where[i];
        const clauseResults = await this.executeClauseWithFilteredDatoms(
          clause,
          afterResult.datoms
        );
        results = joinResults(
          results,
          clauseResults,
          modifiedQuery.where.slice(0, i + 1)
        );
      }

      // Apply aggregations in-memory
      const aggregated = applyAggregations(results, modifiedQuery.find);
      const projected = project(
        aggregated,
        modifiedQuery.find,
        modifiedQuery.where
      );

      if (modifiedQuery.orderBy) {
        projected.sort((a, b) => {
          for (const [variable, direction] of modifiedQuery.orderBy!) {
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

      if (modifiedQuery.limit) {
        return projected.slice(0, modifiedQuery.limit);
      }

      return projected;
    }

    // For multi-clause queries with all aggregations supported, use SQL query building
    if (modifiedQuery.where.length > 1 && hasAggs && allAggsSupported) {
      return this.executeDatalogWithSQL(modifiedQuery);
    }

    // Now execute the query with filtered datoms (no aggregations or single clause with supported aggregations)
    const firstClause = modifiedQuery.where[0];
    const firstResults = await this.executeClauseWithFilteredDatoms(
      firstClause,
      afterResult.datoms
    );

    let results = firstResults;
    for (let i = 1; i < modifiedQuery.where.length; i++) {
      const clause = modifiedQuery.where[i];
      const clauseResults = await this.executeClauseWithFilteredDatoms(
        clause,
        afterResult.datoms
      );
      results = joinResults(
        results,
        clauseResults,
        modifiedQuery.where.slice(0, i + 1)
      );
    }

    const projected = project(results, modifiedQuery.find, modifiedQuery.where);

    if (modifiedQuery.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of modifiedQuery.orderBy!) {
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

    if (modifiedQuery.limit) {
      return projected.slice(0, modifiedQuery.limit);
    }

    return projected;
  }

  /**
   * Execute a clause and return datoms (for hook support)
   */
  private async executeClauseAsDatoms(clause: QueryClause): Promise<Datom[]> {
    if (!isQueryPattern(clause)) {
      throw new Error("Only QueryPattern clauses are supported");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    return this.executeQuery({
      e: entity,
      a: attribute,
      v: value,
      op: "assert",
    });
  }

  /**
   * Execute a clause using filtered datoms from hooks
   */
  private async executeClauseWithFilteredDatoms(
    clause: QueryClause,
    filteredDatoms: Datom[]
  ): Promise<Record<string, Value | Attribute>[]> {
    if (!isQueryPattern(clause)) {
      throw new Error("Only QueryPattern clauses are supported");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Filter datoms based on clause
    let matchingDatoms = filteredDatoms;
    if (entity !== undefined) {
      matchingDatoms = matchingDatoms.filter((d) => d.e === entity);
    }
    if (attribute !== undefined) {
      matchingDatoms = matchingDatoms.filter((d) => d.a === attribute);
    }
    if (value !== undefined) {
      matchingDatoms = matchingDatoms.filter(
        (d) => JSON.stringify(d.v) === JSON.stringify(value)
      );
    }

    // Map datom fields to variable names from the clause
    return matchingDatoms.map((datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom.e;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.a;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.v;
      }
      return result;
    });
  }

  /**
   * Execute datalog query using SQL with aggregations
   */
  private async executeDatalogWithSQL(
    query: DatalogQuery
  ): Promise<QueryResult> {
    const clauses = query.where;
    const params: unknown[] = [];
    const ctes: string[] = [];
    const selectColumns: string[] = [];
    const joinConditions: string[] = [];

    // Build CTEs for each clause with deduplication using DISTINCT ON
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      if (!isQueryPattern(clause)) {
        throw new Error(
          "Only QueryPattern clauses are supported in SQL queries"
        );
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const alias = `d${i}`;

      const conditions: string[] = [];

      // Add filters for bound values
      if (!isVariable(entityVal)) {
        conditions.push(`e = ?`);
        params.push(String(entityVal));
      }
      if (!isVariable(attributeVal)) {
        conditions.push(`a = ?`);
        params.push(String(attributeVal));
      }
      if (!isVariable(valueVal)) {
        let value = valueVal as Value;
        if (value === undefined) {
          value = "__UNDEFINED__";
        }
        conditions.push(`v = ?::jsonb`);
        params.push(JSON.stringify(value));
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // PostgreSQL uses DISTINCT ON for deduplication
      const cte = `
        ${alias} AS (
          SELECT DISTINCT ON (e, a, v)
            e, a, v, tx
          FROM ${this.tableName}
          ${whereClause}
          ORDER BY e, a, v, tx DESC
        )`;

      ctes.push(cte);

      // Build SELECT columns for variables (only if not aggregating)
      // Aggregations will be handled separately
    }

    // Map variables to their column references for aggregations
    const variableToColumn: Map<string, string> = new Map();
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      if (!isQueryPattern(clause)) {
        continue;
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const alias = `d${i}`;
      if (isVariable(entityVal)) {
        variableToColumn.set(entityVal as string, `${alias}.e`);
      }
      if (isVariable(attributeVal)) {
        variableToColumn.set(attributeVal as string, `${alias}.a`);
      }
      if (isVariable(valueVal)) {
        variableToColumn.set(valueVal as string, `${alias}.v`);
      }
    }

    // Build JOIN conditions based on shared variables
    const variableToClause: Map<
      string,
      { clauseIndex: number; field: string }[]
    > = new Map();

    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      if (!isQueryPattern(clause)) {
        throw new Error(
          "Only QueryPattern clauses are supported in JOIN conditions"
        );
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;

      if (isVariable(entityVal)) {
        const varName = entityVal as string;
        if (!variableToClause.has(varName)) {
          variableToClause.set(varName, []);
        }
        variableToClause.get(varName)!.push({ clauseIndex: i, field: "e" });
      }
      if (isVariable(attributeVal)) {
        const varName = attributeVal as string;
        if (!variableToClause.has(varName)) {
          variableToClause.set(varName, []);
        }
        variableToClause.get(varName)!.push({ clauseIndex: i, field: "a" });
      }
      if (isVariable(valueVal)) {
        const varName = valueVal as string;
        if (!variableToClause.has(varName)) {
          variableToClause.set(varName, []);
        }
        variableToClause.get(varName)!.push({ clauseIndex: i, field: "v" });
      }
    }

    // Build JOIN conditions for shared variables
    for (const occurrences of variableToClause.values()) {
      if (occurrences.length > 1) {
        for (let i = 1; i < occurrences.length; i++) {
          const prev = occurrences[i - 1];
          const curr = occurrences[i];
          const prevAlias = `d${prev.clauseIndex}`;
          const currAlias = `d${curr.clauseIndex}`;
          joinConditions.push(
            `${prevAlias}.${prev.field} = ${currAlias}.${curr.field}`
          );
        }
      }
    }

    // Build aggregation SELECT columns
    const groupByColumns: string[] = [];
    const findKeys = Object.keys(query.find);
    for (const outputKey of findKeys) {
      const expr = query.find[outputKey];
      const agg = parseAggregation(expr);

      if (agg) {
        // This is an aggregation - convert to SQL
        const varName = agg.variable;
        const columnRef = variableToColumn.get(varName);
        if (columnRef) {
          const sqlAgg = aggregationToSQL(
            expr,
            columnRef,
            "postgresql",
            outputKey
          );
          if (sqlAgg && sqlAgg.sql) {
            selectColumns.push(sqlAgg.sql);
          } else {
            // Unsupported aggregation - return null
            selectColumns.push(`NULL AS "${outputKey}"`);
          }
        } else {
          // Variable not found - return null
          selectColumns.push(`NULL AS "${outputKey}"`);
        }
      } else {
        // Regular variable - include in SELECT and GROUP BY
        let varName: string;
        if (
          Array.isArray(expr) &&
          expr.length === 1 &&
          typeof expr[0] === "string"
        ) {
          varName = expr[0];
        } else if (typeof expr === "string") {
          varName = expr;
        } else {
          continue;
        }

        const columnRef = variableToColumn.get(varName);
        if (columnRef) {
          selectColumns.push(`${columnRef} AS "${outputKey}"`);
          groupByColumns.push(columnRef);
        }
      }
    }

    // Build the final SQL query
    const cteClause = ctes.length > 0 ? `WITH ${ctes.join(", ")}` : "";
    const fromClause = `FROM d0`;

    // Build JOIN clauses
    const joinClauses: string[] = [];
    for (let i = 1; i < clauses.length; i++) {
      const alias = `d${i}`;
      const conditions: string[] = [];

      for (const joinCond of joinConditions) {
        if (joinCond.includes(`${alias}.`)) {
          const parts = joinCond.split(" = ");
          if (parts.length === 2) {
            if (parts[0].startsWith(`${alias}.`)) {
              conditions.push(joinCond);
            } else if (parts[1].startsWith(`${alias}.`)) {
              conditions.push(`${parts[1]} = ${parts[0]}`);
            }
          }
        }
      }

      if (conditions.length > 0) {
        joinClauses.push(`JOIN ${alias} ON ${conditions.join(" AND ")}`);
      } else {
        joinClauses.push(`CROSS JOIN ${alias}`);
      }
    }

    const joinClause = joinClauses.join(" ");

    // Build ORDER BY clause
    let orderByClause = "";
    if (query.orderBy && query.orderBy.length > 0) {
      const orderParts = query.orderBy
        .map(([variable, direction]) => {
          for (let i = 0; i < clauses.length; i++) {
            const clause = clauses[i];
            if (!isQueryPattern(clause)) {
              continue;
            }
            const { e: entityVal, a: attributeVal, v: valueVal } = clause;
            if (entityVal === variable) {
              return `d${i}.e ${direction.toUpperCase()}`;
            }
            if (attributeVal === variable) {
              return `d${i}.a ${direction.toUpperCase()}`;
            }
            if (valueVal === variable) {
              return `d${i}.v ${direction.toUpperCase()}`;
            }
          }
          return "";
        })
        .filter(Boolean);
      if (orderParts.length > 0) {
        orderByClause = `ORDER BY ${orderParts.join(", ")}`;
      }
    }

    // Build GROUP BY clause if we have aggregations with non-aggregated columns
    let groupByClause = "";
    if (groupByColumns.length > 0) {
      groupByClause = `GROUP BY ${groupByColumns.join(", ")}`;
    }

    const limitClause = query.limit ? `LIMIT ?` : "";
    if (query.limit) {
      params.push(query.limit);
    }

    const sql = `
      ${cteClause}
      SELECT ${selectColumns.join(", ")}
      ${fromClause}
      ${joinClause}
      ${groupByClause}
      ${orderByClause}
      ${limitClause}
    `;

    const rows = await this.connection.query(sql, params);

    // Convert SQL results back to QueryResult format
    const reviveValue = (value: unknown): unknown => {
      if (value === null || value === undefined) {
        return value;
      }
      if (typeof value === "string") {
        // For numeric strings (like aggregation results), try to convert to number first
        // This handles cases where PostgreSQL returns COUNT(*) as a string "2"
        if (/^-?\d+$/.test(value)) {
          const num = parseInt(value, 10);
          if (!isNaN(num)) {
            return num;
          }
        }
        if (/^-?\d*\.\d+$/.test(value)) {
          const num = parseFloat(value);
          if (!isNaN(num)) {
            return num;
          }
        }
        // Try to parse as JSON, but if it fails, use the string as-is
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
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

    const results: Record<string, Value | Attribute>[] = rows.map(
      (row: DatabaseRow) => {
        const result: Record<string, Value | Attribute> = {};
        for (const key of Object.keys(row)) {
          let value: unknown = row[key];
          // PostgreSQL stores values as JSONB, so parse them
          // But for aggregation results, they might already be numbers or strings
          if (typeof value === "string") {
            // For numeric strings (aggregation results), convert directly
            if (/^-?\d+$/.test(value)) {
              const num = parseInt(value, 10);
              if (!isNaN(num)) {
                value = num;
              } else {
                // Try JSON parse for other string values
                try {
                  value = JSON.parse(value);
                } catch {
                  // Not valid JSON, keep as string
                }
              }
            } else {
              // Try JSON parse for non-numeric strings
              try {
                value = JSON.parse(value);
              } catch {
                // Not valid JSON, keep as string
              }
            }
          }
          result[key] = reviveValue(value) as Value | Attribute;
        }
        return result;
      }
    );

    // For SQL queries with aggregations, the results already have output keys as column names
    // We just need to map them directly without calling applyAggregations again
    // (The project function would try to re-aggregate, but we've already done it in SQL)
    if (Object.keys(query.find).length === 0) {
      return results;
    }

    // Map results - they already have output keys as keys (from SQL aliases)
    return results.map((row) => {
      const projected: Record<string, Value | Attribute> = {};
      for (const outputKey of Object.keys(query.find)) {
        if (outputKey in row) {
          projected[outputKey] = row[outputKey];
        }
      }
      return projected;
    });
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
      INSERT INTO ${this.tableName} (e, a, v, tx, op)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `;

    const params = datoms.flatMap((d) => {
      let value = d.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      return [String(d.e), String(d.a), JSON.stringify(value), tx, "assert"];
    });

    await this.connection.execute(sql, params);
  }

  private async subDatomsInternal(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (e, a, v, tx, op)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `;

    const params = datoms.flatMap((d) => {
      let value = d.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      return [String(d.e), String(d.a), JSON.stringify(value), tx, "retract"];
    });

    await this.connection.execute(sql, params);
  }

  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value | Attribute>[]> {
    if (!isQueryPattern(clause)) {
      throw new Error("Only QueryPattern clauses are supported");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Datalog queries manage their own limiting via joins, so bypass validation
    const queryOptions: QueryOptions = {
      ...(entity !== undefined && { e: entity }),
      ...(attribute !== undefined && { a: attribute }),
      ...(value !== undefined && { v: value }),
    };

    const datoms = await this.queryInternal(queryOptions);

    return datoms.map((datom: Datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom.e;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.a;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.v;
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

    // Count total datoms (only add ones, latest version)
    // PostgreSQL-specific: Use DISTINCT ON for efficient latest-row-per-group
    const countSql = `
      WITH latest_datoms AS (
        SELECT DISTINCT ON (e, a, v)
          e, a, v, tx, op
        FROM ${this.tableName}
        ORDER BY e, a, v, tx DESC
      )
      SELECT COUNT(*) as count
      FROM latest_datoms
      WHERE op = 'assert'
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
      SELECT COUNT(DISTINCT e) as count
      FROM ${this.tableName}
      WHERE op = 'assert'
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
}
