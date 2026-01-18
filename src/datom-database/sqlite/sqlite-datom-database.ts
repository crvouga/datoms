/**
 * SQLite database implementation
 * Accepts a SqlConnection interface for SQLite-compatible databases
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  TransactionId,
  Value,
} from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import {
  deserializeEntityId,
  serializeEntityId,
  validateEntityId,
} from "../../entity-id.js";
import type { SQLDatabase } from "../../sql-database/sql-database.js";
import type { QueryOptions, Transaction } from "../../types.js";
import type { WithResult } from "../datom-database.js";
import { DatomDatabase } from "../datom-database.js";
import {
  Hook,
  HookEngine,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionError,
  type ReadContext,
  type WriteContext,
  type WriteResult,
} from "../hook/hook.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { joinResults, project } from "../shared/query-results.js";
import { DatabaseView } from "../views/database-view.js";
import {
  ConfiguredDatabaseView,
  type InternalDatabaseView,
  type ViewConfig,
} from "../views/internal-database-view.js";

/**
 * SQLite database implementation
 * Accepts a SqlDatabase that implements SQLite-compatible SQL
 */
export class SQLiteDatomDatabase
  implements DatomDatabase, InternalDatabaseView
{
  public readonly hooks: HookEngine;
  protected initialized = false;
  private connection: SQLDatabase;
  private tableName: string;
  private queryCount: number = 0;
  private transactionCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionTimeSum: number = 0;

  constructor(connection: SQLDatabase, tableName: string = "datoms") {
    this.hooks = new HookEngine();
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

  hook(hook: Hook): void {
    this.hooks.register(hook);
  }

  protected async writeDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();
    await this.writeDatomsInternal(datoms, tx);
    return tx;
  }

  async transact(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId> {
    await this.ensureInitialized();

    // Create write context
    const ctx: WriteContext = {
      db: this,
      txMeta: metadata,
      ...(context || {}),
    };

    // Process operations sequentially
    const adds: DatomInput[] = [];
    const subs: DatomInput[] = [];

    for (const op of ops.flat()) {
      const datom = { e: op.e, a: op.a, v: op.v, op: op.op };

      if (op.op === "assert") {
        // Validate add, accounting for subs already processed
        await this.validateDatoms([datom], true, subs);
        adds.push(datom);
      } else {
        // Validate sub
        await this.validateDatoms([datom], false);
        subs.push(datom);
      }
    }

    // Convert to datoms for transaction object
    const allDatoms: Datom[] = [];
    const latestTx = await this.getLatestTransaction();
    const txId = latestTx + 1;

    for (const sub of subs) {
      allDatoms.push({
        e: sub.e,
        a: sub.a,
        v: sub.v,
        tx: txId,
        op: "retract",
      });
    }

    for (const add of adds) {
      allDatoms.push({
        e: add.e,
        a: add.a,
        v: add.v,
        tx: txId,
        op: "assert",
      });
    }

    // Create transaction object
    const tx: Transaction = {
      datoms: allDatoms,
      meta: metadata,
    };

    // Run before-write hooks
    const beforeResult = await this.hooks.runBeforeWrite(tx, ctx);

    if (beforeResult.errors.length > 0) {
      throw new TransactionError(
        "Transaction validation failed",
        beforeResult.errors
      );
    }

    // Combine all datoms from the modified transaction (using the modified transaction from hooks)
    const finalTx = beforeResult.tx;
    const allFinalDatoms = finalTx.datoms.map((d) => ({
      e: d.e,
      a: d.a,
      v: d.v,
      op: d.op,
    }));

    // Write all datoms (both adds and subs) in a single call
    // If there are no operations, still create a new transaction ID
    const committedTxId = await this.writeDatoms(allFinalDatoms);

    // Store metadata if provided
    if (metadata !== undefined) {
      await this.onTransactionMetadata(committedTxId, metadata);
    }

    // Create write result for after-write hooks
    const writeResult: WriteResult = {
      txId: committedTxId,
      datoms: finalTx.datoms.map((d) => ({ ...d, tx: committedTxId })),
      timestamp: Date.now(),
    };

    // Run after-write hooks (fire and forget, don't block)
    this.hooks.runAfterWrite(writeResult, ctx).catch((err) => {
      console.error("After-write hook failed:", err);
    });

    return committedTxId;
  }

  async onTransactionMetadata(
    _txId: TransactionId,
    _metadata: Record<string, unknown>
  ): Promise<void> {
    // Optional: Override in implementations if metadata storage is needed
    // Default: no-op (metadata is ignored but still emitted in events)
  }

  protected async validateDatoms(
    datoms: DatomInput[],
    _isAdd: boolean,
    _subsInSameTransaction?: DatomInput[]
  ): Promise<void> {
    // Basic runtime validation for cases where TypeScript types are bypassed
    for (const datom of datoms) {
      if (datom.e === null || datom.e === undefined) {
        throw new Error("Datom must have an entity ID");
      }
      if (datom.a === null || datom.a === undefined) {
        throw new Error("Datom must have an attribute");
      }
    }
  }

  protected async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Execute query with timeout if specified
    let results: Datom[];
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new QueryTimeoutError(options.timeoutMs!, options));
        }, options.timeoutMs);
      });

      const queryPromise = this.executeQuery(options);
      results = await Promise.race([queryPromise, timeoutPromise]);
    } else {
      results = await this.executeQuery(options);
    }

    // Check result size limit if specified
    if (
      options.maxResultSize !== undefined &&
      results.length > options.maxResultSize
    ) {
      throw new QueryResultSizeError(
        results.length,
        options.maxResultSize,
        options
      );
    }

    return results;
  }

  asOf(txId: TransactionId): DatabaseView {
    return new ConfiguredDatabaseView(this, { type: "asOf", txId });
  }

  history(): DatabaseView {
    return new ConfiguredDatabaseView(this, { type: "history" });
  }

  since(txId: TransactionId): DatabaseView {
    return new ConfiguredDatabaseView(this, { type: "since", txId });
  }

  async with(ops: DatomInput[]): Promise<WithResult> {
    await this.ensureInitialized();

    // Get the next transaction ID for speculative datoms
    const speculativeTxId = (await this.getLatestTransaction()) + 1;

    // Process operations in sequence, creating speculative datoms directly
    const speculativeAsserts: Datom[] = [];
    const speculativeRetracts: Datom[] = [];

    for (const op of ops) {
      const speculativeDatom: Datom = {
        e: op.e,
        a: op.a,
        v: op.v,
        tx: speculativeTxId,
        op: op.op,
      };

      if (op.op === "assert") {
        speculativeAsserts.push(speculativeDatom);
      } else {
        speculativeRetracts.push(speculativeDatom);
      }
    }

    // Create dbBefore view (current state)
    const dbBefore = new ConfiguredDatabaseView(this, { type: "current" });

    // Create dbAfter view (speculative state)
    const dbAfter = new ConfiguredDatabaseView(this, {
      type: "speculative",
      adds: speculativeAsserts,
      subs: speculativeRetracts,
    });

    // Generate txData (all datoms that would be applied)
    const txData: Datom[] = [...speculativeRetracts, ...speculativeAsserts];

    return {
      dbBefore,
      dbAfter,
      txData,
      tempIds: {}, // Empty for now, reserved for future tempid support
    };
  }

  // EntityId utility methods (delegating to shared utilities)
  // These are kept for backward compatibility but are not part of the DatomDatabase interface
  validateEntityId(entityId: unknown): entityId is EntityId {
    return validateEntityId(entityId);
  }

  serializeEntityId(entityId: EntityId): string {
    return serializeEntityId(entityId);
  }

  deserializeEntityId(serialized: string): EntityId {
    return deserializeEntityId(serialized);
  }

  async executeQuery(options: QueryOptions): Promise<Datom[]> {
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
      projected.sort(
        (
          a: Record<string, Value | Attribute>,
          b: Record<string, Value | Attribute>
        ) => {
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
        }
      );
    }

    // Apply limit if specified
    if (query.limit !== undefined) {
      return projected.slice(0, query.limit);
    }

    return projected;
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

  private async writeDatomsInternal(
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
      return [String(d.e), String(d.a), JSON.stringify(value), tx, d.op];
    });

    await this.connection.execute(sql, params);
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

  public async _executeQuery(
    options: QueryOptions,
    viewConfig: ViewConfig
  ): Promise<Datom[]> {
    await this.ensureInitialized();

    if (viewConfig.type === "current") {
      return this.executeQuery(options);
    }
    if (viewConfig.type === "asOf") {
      return this.executeAsOfQuery(options, viewConfig.txId);
    }
    if (viewConfig.type === "since") {
      return this.executeSinceQuery(options, viewConfig.txId);
    }
    if (viewConfig.type === "history") {
      return this.executeHistoryQuery(options);
    }
    if (viewConfig.type === "speculative") {
      // For speculative queries, we need to merge base datoms with speculative changes
      // Get all base datoms (current state)
      const baseDatoms = await this.executeQuery({});

      // Create a map of base datoms by (entity, attribute, value) for efficient lookup
      const baseMap = new Map<string, Datom>();
      for (const datom of baseDatoms) {
        const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
        baseMap.set(key, datom);
      }

      // Apply subs first (remove matching datoms)
      for (const sub of viewConfig.subs) {
        const key = `${String(sub.e)}|${String(sub.a)}|${JSON.stringify(sub.v)}`;
        baseMap.delete(key);
      }

      // Apply adds (add or update datoms)
      for (const add of viewConfig.adds) {
        const key = `${String(add.e)}|${String(add.a)}|${JSON.stringify(add.v)}`;
        baseMap.set(key, add);
      }

      // Create merged datoms array
      const mergedDatoms = Array.from(baseMap.values());

      // Apply filters from options
      let results = mergedDatoms;
      if (options.e !== undefined) {
        results = results.filter((d) => d.e === options.e);
      }
      if (options.a !== undefined) {
        results = results.filter((d) => d.a === options.a);
      }
      if (options.v !== undefined) {
        results = results.filter((d) => d.v === options.v);
      }
      if (options.tx !== undefined) {
        results = results.filter((d) => d.tx === options.tx);
      }
      if (options.op !== undefined) {
        results = results.filter((d) => d.op === options.op);
      } else {
        // Default: only assert
        results = results.filter((d) => d.op === "assert");
      }

      // Apply pagination
      const offset = options.offset ?? 0;
      const limit = options.limit;
      return results.slice(offset, limit ? offset + limit : undefined);
    }

    // TypeScript exhaustiveness check
    const _exhaustive: never = viewConfig;
    throw new Error(
      `Unknown view config type: ${(_exhaustive as ViewConfig).type}`
    );
  }

  public async _executeDatalogQuery(
    query: DatalogQuery,
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig
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

    // For single clause queries, use optimized path
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

      const datoms = await this._executeQuery(
        {
          e: entity,
          a: attribute,
          v: value,
          op: "assert",
        },
        viewConfig
      );

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

    // For multi-clause queries, extract datoms first for afterRead hooks
    const allDatomsSet = new Set<string>();
    const allDatoms: Datom[] = [];

    for (const clause of modifiedQuery.where) {
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

      const clauseDatoms = await this._executeQuery(
        {
          e: entity,
          a: attribute,
          v: value,
          op: "assert",
        },
        viewConfig
      );

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

    // For speculative views, we need to use in-memory join logic
    // For other views, we can use SQL-based joins
    if (viewConfig.type === "speculative") {
      // Use in-memory join logic for speculative queries
      const firstClause = modifiedQuery.where[0];
      if (!isQueryPattern(firstClause)) {
        throw new Error("First clause must be a QueryPattern");
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = firstClause;
      const entity = isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const firstDatoms = await this._executeQuery(
        {
          e: entity,
          a: attribute,
          v: value,
        },
        viewConfig
      );

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

      let results = firstResults;
      for (let i = 1; i < modifiedQuery.where.length; i++) {
        const clause = modifiedQuery.where[i];
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

        const clauseDatoms = await this._executeQuery(
          {
            e: entity,
            a: attribute,
            v: value,
          },
          viewConfig
        );

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
          modifiedQuery.where.slice(0, i + 1)
        );
      }

      const projected = project(
        results,
        modifiedQuery.find,
        modifiedQuery.where
      );
      return this.applyOrderAndLimit(projected, modifiedQuery);
    }

    // For non-speculative views, use SQL-based query execution
    // Re-execute query with filtered datoms
    return this.executeDatalogWithSQLAndFilteredDatoms(
      modifiedQuery,
      afterResult.datoms
    );
  }
}
