/**
 * SQLite database implementation
 * Accepts a SqlConnection interface for SQLite-compatible databases
 */

import type {
  Attribute,
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../../types.js";
import { DatomDatabase } from "../datom-database.js";
import type { ReadContext } from "../hook/hook.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { joinResults, project } from "../shared/query-helpers.js";
import {
  aggregationToSQL,
  checkSQLAggregations,
} from "../shared/aggregations/shared/helpers.js";
import { parseAggregation } from "../shared/aggregations/index.js";
import { applyAggregations } from "../shared/aggregations/index.js";

import type {
  DatalogQuery,
  DatalogQueryFindVariable,
  QueryClause,
  QueryResult,
} from "../../datalog/datalog.js";
import type { SQLDatabase } from "../../sql-database/sql-database.js";
import { QueryError } from "../datom-database.js";

/**
 * SQLite database implementation
 * Accepts a SqlDatabase that implements SQLite-compatible SQL
 */
export class SQLiteDatomDatabase extends DatomDatabase {
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
          e TEXT NOT NULL,
          a TEXT NOT NULL,
          v TEXT NOT NULL,
          tx INTEGER NOT NULL,
          op TEXT NOT NULL CHECK(op IN ('assert', 'retract')),
          PRIMARY KEY (e, a, v, tx, op)
        )
      `;

      // Optimized composite indexes for common query patterns
      const indexes = [
        // Composite index for entity+attribute queries (most common pattern)
        // SQLite doesn't support DESC in index definition, but this helps with filtering
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e_a_tx ON ${this.tableName}(e, a, tx)`,
        // Composite index for attribute+value queries
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_v_tx ON ${this.tableName}(a, v, tx)`,
        // Index on tx for transaction-based queries (DESC ordering handled in query)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx)`,
        // Covering index for entity lookups
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e ON ${this.tableName}(e)`,
      ];

      await this.connection.execute(createTableSql);
      for (const indexSql of indexes) {
        await this.connection.execute(indexSql);
      }

      // Create transaction counter table
      const txTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName}_tx (
          id INTEGER PRIMARY KEY,
          last_tx INTEGER NOT NULL DEFAULT 0
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
    await this.addDatomsInternal(datoms, tx);
    return tx;
  }

  protected async subDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();
    await this.subDatomsInternal(datoms, tx);
    return tx;
  }

  public async getRawDatoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      conditions.push("v = ?");
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
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

    return rows.map((row: Record<string, unknown>) => {
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      const parsedValue: unknown = JSON.parse(String(row.v));
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
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.e !== undefined) {
      conditions.push("e = ?");
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push("a = ?");
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      conditions.push("v = ?");
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Use SQL-level deduplication with ROW_NUMBER() window function
    // Deduplicate by (e, a, v) to support multi-valued attributes
    const partitionByColumns = "e, a, v";

    // Build the op filter
    let opFilter = "";
    if (options.op === undefined || options.op === "assert") {
      opFilter = "AND op = 'assert'";
    } else if (options.op === "retract") {
      opFilter = "AND op = 'retract'";
    }

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          e,
          a,
          v,
          tx,
          op,
          ROW_NUMBER() OVER (
            PARTITION BY ${partitionByColumns}
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ranked_datoms
      WHERE rn = 1
      ${opFilter}
      ORDER BY
        CASE 
          WHEN e GLOB '-[0-9]*' OR e GLOB '[0-9]*' THEN CAST(e AS INTEGER)
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

    return rows.map((row: Record<string, unknown>) => {
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      const parsedValue: unknown = JSON.parse(String(row.v));
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
      conditions.push("v = ?");
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
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

    // Use ROW_NUMBER() OVER to deduplicate by (e, a)
    // This keeps the latest value per attribute (asOf semantics)
    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          e,
          a,
          v,
          tx,
          op,
          ROW_NUMBER() OVER (
            PARTITION BY e, a
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ranked_datoms
      WHERE rn = 1 AND op = 'assert'
      ORDER BY
        CASE 
          WHEN e GLOB '-[0-9]*' OR e GLOB '[0-9]*' THEN CAST(e AS INTEGER)
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
      conditions.push("v = ?");
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
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
      conditions.push("v = ?");
      let value = options.v;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      params.push(JSON.stringify(value));
    }

    // Filter to only datoms with tx > txId
    conditions.push("tx > ?");
    params.push(txId);

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    // Use ROW_NUMBER() OVER to deduplicate by (e, a, v)
    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          e,
          a,
          v,
          tx,
          op,
          ROW_NUMBER() OVER (
            PARTITION BY e, a, v
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ranked_datoms
      WHERE rn = 1 AND op = 'assert'
      ORDER BY
        CASE 
          WHEN e GLOB '-[0-9]*' OR e GLOB '[0-9]*' THEN CAST(e AS INTEGER)
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
    return this.mapRowsToDatoms(rows);
  }

  /**
   * Helper method to map database rows to Datom objects
   * Reused across query methods
   */
  private mapRowsToDatoms(rows: Record<string, unknown>[]): Datom[] {
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

    return rows.map((row: Record<string, unknown>) => {
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      const parsedValue: unknown = JSON.parse(String(row.v));
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

    // For single clause queries, use the optimized query method
    if (modifiedQuery.where.length === 1) {
      const clause = modifiedQuery.where[0];
      if (!isQueryPattern(clause)) {
        throw new Error("Only QueryPattern clauses are supported");
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const entity = isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const datoms = await this.executeQuery({
        e: entity,
        a: attribute,
        v: value,
        op: "assert",
      });

      // Run after-read hooks
      const afterResult = await this.hooks.runAfterRead(datoms, ctx);

      if (afterResult.errors && afterResult.errors.length > 0) {
        throw new QueryError(
          "Query blocked by after-read hooks",
          afterResult.errors
        );
      }

      const results = afterResult.datoms.map((datom) => {
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

      const projected = project(
        results,
        modifiedQuery.find,
        modifiedQuery.where
      );
      return this.applyOrderAndLimit(projected, modifiedQuery);
    }

    // For multi-clause queries, build a single SQL query with JOINs
    // Extract datoms first for afterRead hooks
    const allDatoms = await this.extractDatomsFromQuery(modifiedQuery);
    const afterResult = await this.hooks.runAfterRead(allDatoms, ctx);

    if (afterResult.errors && afterResult.errors.length > 0) {
      throw new QueryError(
        "Query blocked by after-read hooks",
        afterResult.errors
      );
    }

    // Re-execute query with filtered datoms
    return this.executeDatalogWithSQLAndFilteredDatoms(
      modifiedQuery,
      afterResult.datoms
    );
  }

  /**
   * Extract all datoms that match a query (before projection)
   */
  private async extractDatomsFromQuery(query: DatalogQuery): Promise<Datom[]> {
    const allDatomsSet = new Set<string>();
    const allDatoms: Datom[] = [];

    for (const clause of query.where) {
      if (!isQueryPattern(clause)) {
        continue;
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const entity = isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const clauseDatoms = await this.executeQuery({
        e: entity,
        a: attribute,
        v: value,
        op: "assert",
      });

      for (const datom of clauseDatoms) {
        const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
        if (!allDatomsSet.has(key)) {
          allDatomsSet.add(key);
          allDatoms.push(datom);
        }
      }
    }

    return allDatoms;
  }

  /**
   * Execute datalog query with filtered datoms from hooks
   * Uses datom-level execution to properly support afterRead hooks
   */
  private async executeDatalogWithSQLAndFilteredDatoms(
    query: DatalogQuery,
    filteredDatoms: Datom[]
  ): Promise<QueryResult> {
    // Create a set of allowed datoms for filtering
    const allowedDatomsSet = new Set<string>();
    for (const datom of filteredDatoms) {
      const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
      allowedDatomsSet.add(key);
    }

    // Execute query at datom level using filtered datoms
    if (query.where.length === 0) {
      return [];
    }

    // Execute first clause using filtered datoms
    const firstClause = query.where[0];
    if (!isQueryPattern(firstClause)) {
      throw new Error("First clause must be a QueryPattern");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = firstClause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Filter datoms for first clause
    let firstDatoms = filteredDatoms;
    if (entity !== undefined) {
      firstDatoms = firstDatoms.filter((d) => d.e === entity);
    }
    if (attribute !== undefined) {
      firstDatoms = firstDatoms.filter((d) => d.a === attribute);
    }
    if (value !== undefined) {
      firstDatoms = firstDatoms.filter(
        (d) => JSON.stringify(d.v) === JSON.stringify(value)
      );
    }

    const firstResults = firstDatoms.map((datom) => {
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

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      if (!isQueryPattern(clause)) {
        throw new Error("Only QueryPattern clauses are supported in joins");
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const entity = isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      // Filter datoms for this clause
      let clauseDatoms = filteredDatoms;
      if (entity !== undefined) {
        clauseDatoms = clauseDatoms.filter((d) => d.e === entity);
      }
      if (attribute !== undefined) {
        clauseDatoms = clauseDatoms.filter((d) => d.a === attribute);
      }
      if (value !== undefined) {
        clauseDatoms = clauseDatoms.filter(
          (d) => JSON.stringify(d.v) === JSON.stringify(value)
        );
      }

      const clauseResults = clauseDatoms.map((datom) => {
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

      results = joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    // Project to find variables
    const projected = project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];
          if (aVal === undefined && bVal === undefined) return 0;
          if (aVal === undefined || aVal === null)
            return direction === "asc" ? 1 : -1;
          if (bVal === undefined || bVal === null)
            return direction === "asc" ? -1 : 1;
          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit if specified
    if (query.limit !== undefined) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  private async executeDatalogWithSQL(
    query: DatalogQuery
  ): Promise<QueryResult> {
    const clauses = query.where;
    const params: unknown[] = [];
    const ctes: string[] = [];
    const selectColumns: string[] = [];
    const joinConditions: string[] = [];

    // Check if we have aggregations and if they're all SQL-supported
    const aggCheck = checkSQLAggregations(query.find, "sqlite");
    const hasAggs = aggCheck.hasAggregations;
    const allAggsSupported = aggCheck.allSupported;

    // If we have unsupported aggregations, fetch raw data and apply aggregations in-memory
    if (hasAggs && !allAggsSupported) {
      // Build query without aggregations to get raw data
      const rawFind: Record<string, DatalogQueryFindVariable> = {};
      for (const [outputKey, expr] of Object.entries(query.find)) {
        const agg = parseAggregation(expr);
        if (!agg) {
          // Keep non-aggregations
          rawFind[outputKey] = expr as DatalogQueryFindVariable;
        } else {
          // For unsupported aggregations, include the variable itself as a tuple
          rawFind[agg.variable] = [agg.variable as `?${string}`];
        }
      }
      const rawQuery: DatalogQuery = { ...query, find: rawFind };
      const rawResults = await this.executeDatalogWithSQLRaw(rawQuery);
      // Apply aggregations in-memory
      const aggregated = applyAggregations(rawResults, query.find);
      return project(aggregated, query.find, query.where);
    }

    // Build CTEs for each clause with deduplication
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
        conditions.push(`v = ?`);
        params.push(JSON.stringify(value));
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Use ROW_NUMBER for deduplication
      const partitionBy = "e, a, v";

      const rankedCte = `
        ${alias}_ranked AS (
          SELECT 
            e,
            a,
            v,
            tx,
            op,
            ROW_NUMBER() OVER (
              PARTITION BY ${partitionBy}
              ORDER BY tx DESC
            ) AS rn
          FROM ${this.tableName}
          ${whereClause}
        )`;

      const cte = `
        ${alias} AS (
          SELECT e, a, v, tx
          FROM ${alias}_ranked
          WHERE rn = 1 AND op = 'assert'
        )`;

      // Store ranked CTE separately, then the final CTE
      ctes.push(rankedCte);
      ctes.push(cte);

      // Build SELECT columns for variables (only if not aggregating)
      if (!hasAggs || !allAggsSupported) {
        // Normal mode: select all variables
        if (isVariable(entityVal)) {
          selectColumns.push(
            `${alias}.e AS ${this.escapeColumnName(entityVal as string)}`
          );
        }
        if (isVariable(attributeVal)) {
          selectColumns.push(
            `${alias}.a AS ${this.escapeColumnName(attributeVal as string)}`
          );
        }
        if (isVariable(valueVal)) {
          selectColumns.push(
            `${alias}.v AS ${this.escapeColumnName(valueVal as string)}`
          );
        }
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
        // This variable appears in multiple clauses, need to join on it
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

    // Build the final SQL query
    const cteClause = ctes.length > 0 ? `WITH ${ctes.join(", ")}` : "";
    const fromClause = `FROM d0`;

    // Build JOIN clauses properly - each table needs its own JOIN with conditions
    const joinClauses: string[] = [];
    for (let i = 1; i < clauses.length; i++) {
      const alias = `d${i}`;
      const conditions: string[] = [];

      // Find all join conditions involving this alias
      for (const joinCond of joinConditions) {
        if (joinCond.includes(`${alias}.`)) {
          // Extract the condition that connects this alias to a previous one
          const parts = joinCond.split(" = ");
          if (parts.length === 2) {
            if (parts[0].startsWith(`${alias}.`)) {
              conditions.push(joinCond);
            } else if (parts[1].startsWith(`${alias}.`)) {
              // Reverse the condition
              conditions.push(`${parts[1]} = ${parts[0]}`);
            }
          }
        }
      }

      if (conditions.length > 0) {
        joinClauses.push(`JOIN ${alias} ON ${conditions.join(" AND ")}`);
      } else {
        // Cross join if no conditions (shouldn't happen in practice)
        joinClauses.push(`CROSS JOIN ${alias}`);
      }
    }

    const joinClause = joinClauses.join(" ");

    // Build ORDER BY clause
    let orderByClause = "";
    if (query.orderBy && query.orderBy.length > 0) {
      const orderParts = query.orderBy
        .map(([variable, direction]) => {
          // Find which clause/alias has this variable
          for (let i = 0; i < clauses.length; i++) {
            const clause = clauses[i];
            if (!isQueryPattern(clause)) {
              continue; // Skip non-pattern clauses in ORDER BY
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

    // Build aggregation SELECT columns if we have aggregations
    const groupByColumns: string[] = [];
    if (hasAggs && allAggsSupported) {
      // Clear regular select columns - we'll build aggregation columns instead
      selectColumns.length = 0;

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

      // Build SELECT columns from find clause
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
              "sqlite",
              outputKey
            );
            if (sqlAgg && sqlAgg.sql) {
              selectColumns.push(sqlAgg.sql);
            } else {
              // Unsupported aggregation - return null
              selectColumns.push(`NULL AS ${this.escapeColumnName(outputKey)}`);
            }
          } else {
            // Variable not found - return null
            selectColumns.push(`NULL AS ${this.escapeColumnName(outputKey)}`);
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
            selectColumns.push(
              `${columnRef} AS ${this.escapeColumnName(outputKey)}`
            );
            groupByColumns.push(columnRef);
          }
        }
      }
    }

    const limitClause = query.limit ? `LIMIT ?` : "";
    if (query.limit) {
      params.push(query.limit);
    }

    // Build GROUP BY clause if we have aggregations with non-aggregated columns
    let groupByClause = "";
    if (hasAggs && allAggsSupported && groupByColumns.length > 0) {
      groupByClause = `GROUP BY ${groupByColumns.join(", ")}`;
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
    const results: Record<string, Value | Attribute>[] = rows.map(
      (row: Record<string, unknown>) => {
        const result: Record<string, Value | Attribute> = {};
        for (const key of Object.keys(row)) {
          let value: unknown = row[key];
          // Parse JSON values - values are stored as JSON strings in SQLite
          if (typeof value === "string") {
            try {
              // Try parsing as JSON first (handles numbers, booleans, objects, arrays, etc.)
              value = JSON.parse(value);
            } catch {
              // Not valid JSON, keep as string
            }
          }
          result[key] = this.reviveValue(value) as Value | Attribute;
        }
        return result;
      }
    );

    // Use the shared project function for projection (aggregations already handled in SQL)
    return project(results, query.find, query.where);
  }

  /**
   * Execute SQL query without aggregation handling (used internally for fetching raw data)
   */
  private async executeDatalogWithSQLRaw(
    query: DatalogQuery
  ): Promise<Record<string, Value | Attribute>[]> {
    const clauses = query.where;
    const params: unknown[] = [];
    const ctes: string[] = [];
    const selectColumns: string[] = [];
    const joinConditions: string[] = [];

    // Build CTEs for each clause with deduplication
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
        conditions.push(`v = ?`);
        params.push(JSON.stringify(value));
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Use ROW_NUMBER for deduplication
      const partitionBy = "e, a, v";

      const rankedCte = `
        ${alias}_ranked AS (
          SELECT 
            e,
            a,
            v,
            tx,
            op,
            ROW_NUMBER() OVER (
              PARTITION BY ${partitionBy}
              ORDER BY tx DESC
            ) AS rn
          FROM ${this.tableName}
          ${whereClause}
        )`;

      const cte = `
        ${alias} AS (
          SELECT e, a, v, tx
          FROM ${alias}_ranked
          WHERE rn = 1 AND op = 'assert'
        )`;

      ctes.push(rankedCte);
      ctes.push(cte);

      // Build SELECT columns for variables
      if (isVariable(entityVal)) {
        selectColumns.push(
          `${alias}.e AS ${this.escapeColumnName(entityVal as string)}`
        );
      }
      if (isVariable(attributeVal)) {
        selectColumns.push(
          `${alias}.a AS ${this.escapeColumnName(attributeVal as string)}`
        );
      }
      if (isVariable(valueVal)) {
        selectColumns.push(
          `${alias}.v AS ${this.escapeColumnName(valueVal as string)}`
        );
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

    const sql = `
      ${cteClause}
      SELECT ${selectColumns.join(", ")}
      ${fromClause}
      ${joinClause}
    `;

    const rows = await this.connection.query(sql, params);

    // Convert SQL results back to format
    return rows.map((row: Record<string, unknown>) => {
      const result: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        let value: unknown = row[key];
        if (typeof value === "string") {
          try {
            value = JSON.parse(value);
          } catch {
            // Not valid JSON, keep as string
          }
        }
        result[key] = this.reviveValue(value) as Value | Attribute;
      }
      return result;
    });
  }

  private escapeColumnName(name: string): string {
    // SQLite column aliases can be quoted or unquoted
    // For safety, quote them if they contain special characters
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return name;
    }
    return `"${name.replace(/"/g, '""')}"`;
  }

  private reviveValue(value: unknown): unknown {
    if (typeof value === "string") {
      if (value === "__UNDEFINED__") {
        return undefined;
      }
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        return new Date(value);
      }
      // Try parsing as JSON if it looks like JSON
      if (
        (value.startsWith("{") || value.startsWith("[")) &&
        value.length > 1
      ) {
        try {
          const parsed: unknown = JSON.parse(value);
          return this.reviveValue(parsed);
        } catch {
          // Not valid JSON, return as string
        }
      }
    }
    if (value === null) {
      return null;
    }
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.reviveValue(v));
    }
    if (typeof value === "object" && value !== null) {
      const revived: Record<string, unknown> = {};
      const valueObj = value as Record<string, unknown>;
      for (const key in valueObj) {
        revived[key] = this.reviveValue(valueObj[key]);
      }
      return revived;
    }
    return value;
  }

  private applyOrderAndLimit(
    results: QueryResult,
    query: DatalogQuery
  ): QueryResult {
    if (query.orderBy) {
      results.sort((a, b) => {
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
      return results.slice(0, query.limit);
    }

    return results;
  }

  private async getNextTransactionId(): Promise<TransactionId> {
    // Optimized: Use INSERT ... ON CONFLICT to atomically initialize and update
    // This reduces from 3 queries to 2 queries (init+update combined, then select)
    const upsertSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      VALUES (1, 0)
      ON CONFLICT(id) DO UPDATE SET last_tx = last_tx + 1
    `;
    await this.connection.execute(upsertSql);

    // Retrieve the updated value
    const selectSql = `
      SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1
    `;
    const result = await this.connection.query(selectSql);
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
        import("../../types.js").DatabaseStats,
        "totalDatoms" | "totalEntities" | "queryMetrics" | "transactionMetrics"
      >
    >
  > {
    const stats: Partial<import("../../types.js").DatabaseStats> = {};

    // Count total datoms (only add ones, latest version)
    const countSql = `
      WITH latest_datoms AS (
        SELECT e, a, v, tx, op,
               ROW_NUMBER() OVER (PARTITION BY e, a, v ORDER BY tx DESC) as rn
        FROM ${this.tableName}
      )
      SELECT COUNT(*) as count
      FROM latest_datoms
      WHERE rn = 1 AND op = 'assert'
    `;
    const countResult = await this.connection.query(countSql);
    const countRow = countResult[0] as Record<string, unknown> | undefined;
    stats.totalDatoms =
      typeof countRow?.count === "number" ? countRow.count : 0;

    // Count unique entities
    const entitySql = `
      SELECT COUNT(DISTINCT e) as count
      FROM ${this.tableName}
      WHERE op = 'assert'
    `;
    const entityResult = await this.connection.query(entitySql);
    const entityRow = entityResult[0] as Record<string, unknown> | undefined;
    stats.totalEntities =
      typeof entityRow?.count === "number" ? entityRow.count : 0;

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
