/**
 * PostgreSQL database implementation
 * Accepts a SqlConnection interface for PostgreSQL-compatible databases
 */

import type {
  DatalogQuery,
  QueryClause,
  QueryResult,
} from "../../datalog/datalog.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  TransactionId,
  Value,
} from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import type { SQLDatabase } from "../../sql-database/sql-database.js";
import type { DatabaseRow } from "../../sql-database/types.js";
import type { Transaction } from "../../types.js";

import type { WithResult } from "../datom-database.js";
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
import { applyAggregations } from "../in-memory/aggregations/computation.js";
import { parseAggregation } from "../in-memory/aggregations/parser.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { joinResults, project } from "../shared/query-results.js";
import { DatabaseView, DatomsParams } from "../views/database-view.js";
import {
  ConfiguredDatabaseView,
  type InternalDatabaseView,
  type ViewConfig,
} from "../views/internal-database-view.js";
import {
  aggregationToSQL,
  checkSQLAggregations,
} from "./aggregations/helpers.js";

/**
 * PostgreSQL database implementation
 * Accepts a SqlDatabase that implements PostgreSQL-compatible SQL
 */
export class PostgreSQLDatomDatabase implements InternalDatabaseView {
  public readonly hooks: HookEngine;
  protected initialized = false;
  private connection: SQLDatabase;
  private tableName: string;

  constructor(connection: SQLDatabase, tableName: string = "datoms") {
    this.hooks = new HookEngine();
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
      } catch (_error) {
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

  hook(hook: Hook): void {
    this.hooks.register(hook);
  }

  private async _writeDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this._getNextTransactionId();

    if (
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    ) {
      await this.connection.beginTransaction();
      try {
        await this._writeDatomsInternal(datoms, tx);
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    } else {
      await this._writeDatomsInternal(datoms, tx);
    }

    return tx;
  }

  async transact(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId> {
    await this._ensureInitialized();

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
        await this._validateDatoms([datom], true, subs);
        adds.push(datom);
      } else {
        // Validate sub
        await this._validateDatoms([datom], false);
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
    const committedTxId = await this._writeDatoms(allFinalDatoms);

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

  private async _validateDatoms(
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

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async datoms(options: DatomsParams): Promise<Datom[]> {
    await this._ensureInitialized();
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

      const queryPromise = this._executeCurrentQuery(options);
      results = await Promise.race([queryPromise, timeoutPromise]);
    } else {
      results = await this._executeCurrentQuery(options);
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
    await this._ensureInitialized();

    // Get the next transaction ID for speculative datoms
    const speculativeTxId = (await this.getLatestTransaction()) + 1;

    // Process operations in sequence, creating speculative datoms directly
    const speculativeDatoms: Datom[] = [];

    for (const op of ops) {
      const speculativeDatom: Datom = {
        e: op.e,
        a: op.a,
        v: op.v,
        tx: speculativeTxId,
        op: op.op,
      };

      speculativeDatoms.push(speculativeDatom);
    }

    // Create dbBefore view (current state)
    const dbBefore = new ConfiguredDatabaseView(this, { type: "current" });

    // Create dbAfter view (speculative state)
    const dbAfter = new ConfiguredDatabaseView(this, {
      type: "speculative",
      datoms: speculativeDatoms,
    });

    // Generate txData (all datoms that would be applied)
    const txData: Datom[] = [...speculativeDatoms];

    return {
      dbBefore,
      dbAfter,
      txData,
      tempIds: {}, // Empty for now, reserved for future tempid support
    };
  }

  private async _executeCurrentQuery(options: DatomsParams): Promise<Datom[]> {
    await this._ensureInitialized();

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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeAsOfQuery(
    options: DatomsParams,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this._ensureInitialized();

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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeHistoryQuery(options: DatomsParams): Promise<Datom[]> {
    await this._ensureInitialized();

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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeSinceQuery(
    options: DatomsParams,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this._ensureInitialized();

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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeSpeculativeQuery(
    options: DatomsParams,
    speculativeDatoms: Datom[]
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // For speculative queries, we need to merge base datoms with speculative changes
    // Get all base datoms (current state)
    const baseDatoms = await this._executeCurrentQuery({});

    // Create a map of base datoms by (entity, attribute, value) for efficient lookup
    const baseMap = new Map<string, Datom>();
    for (const datom of baseDatoms) {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
      baseMap.set(key, datom);
    }

    // Apply speculative datoms (retracts remove, asserts add/update)
    for (const speculativeDatom of speculativeDatoms) {
      const key = `${String(speculativeDatom.e)}|${String(speculativeDatom.a)}|${JSON.stringify(speculativeDatom.v)}`;
      if (speculativeDatom.op === "retract") {
        baseMap.delete(key);
      } else {
        baseMap.set(key, speculativeDatom);
      }
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

  /**
   * Helper method to map database rows to Datom objects
   * Reused across query methods
   */
  private _mapRowsToDatoms(rows: DatabaseRow[]): Datom[] {
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
      const revivedValue = this._reviveValue(parsedValue) as Value;

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

  private _reviveValue(value: unknown): unknown {
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
      return value.map((v) => this._reviveValue(v));
    }
    if (typeof value === "object" && value !== null) {
      const revived: Record<string, unknown> = {};
      const valueObj = value as Record<string, unknown>;
      for (const key in valueObj) {
        revived[key] = this._reviveValue(valueObj[key]);
      }
      return revived;
    }
    return value;
  }

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    await this._ensureInitialized();

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
      const clauseDatoms = await this._executeClauseAsDatoms(clause);
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
    const aggCheck = checkSQLAggregations(modifiedQuery.find);
    const hasAggs = aggCheck.hasAggregations;
    const allAggsSupported = aggCheck.allSupported;

    // If we have unsupported aggregations, use in-memory approach (for both single and multi-clause)
    if (hasAggs && !allAggsSupported) {
      // Use in-memory joins and aggregations
      const firstClause = modifiedQuery.where[0];
      const firstResults = await this._executeClauseWithFilteredDatoms(
        firstClause,
        afterResult.datoms
      );

      let results = firstResults;
      for (let i = 1; i < modifiedQuery.where.length; i++) {
        const clause = modifiedQuery.where[i];
        const clauseResults = await this._executeClauseWithFilteredDatoms(
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
      return this._executeDatalogWithSQL(modifiedQuery);
    }

    // Now execute the query with filtered datoms (no aggregations or single clause with supported aggregations)
    const firstClause = modifiedQuery.where[0];
    const firstResults = await this._executeClauseWithFilteredDatoms(
      firstClause,
      afterResult.datoms
    );

    let results = firstResults;
    for (let i = 1; i < modifiedQuery.where.length; i++) {
      const clause = modifiedQuery.where[i];
      const clauseResults = await this._executeClauseWithFilteredDatoms(
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
  private async _executeClauseAsDatoms(clause: QueryClause): Promise<Datom[]> {
    if (!isQueryPattern(clause)) {
      throw new Error("Only QueryPattern clauses are supported");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    return this._executeCurrentQuery({
      e: entity,
      a: attribute,
      v: value,
      op: "assert",
    });
  }

  /**
   * Execute a clause using filtered datoms from hooks
   */
  private async _executeClauseWithFilteredDatoms(
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
  private async _executeDatalogWithSQL(
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
          const sqlAgg = aggregationToSQL(expr, columnRef, outputKey);
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
    // Note: Special handling for aggregation results (numeric strings)

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
          // For aggregation results, handle numeric strings specially
          let finalValue = value;
          if (typeof value === "string") {
            // For numeric strings (like aggregation results), try to convert to number first
            if (/^-?\d+$/.test(value)) {
              const num = parseInt(value, 10);
              if (!isNaN(num)) {
                finalValue = num;
              }
            } else if (/^-?\d*\.\d+$/.test(value)) {
              const num = parseFloat(value);
              if (!isNaN(num)) {
                finalValue = num;
              }
            }
          }
          result[key] = this._reviveValue(finalValue) as Value | Attribute;
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
    await this._ensureInitialized();
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

  private async _getNextTransactionId(): Promise<TransactionId> {
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

  private async _writeDatomsInternal(
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
    await this._ensureInitialized();
    const sql = `SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1`;
    const result = await this.connection.query(sql);
    if (!result || result.length === 0) {
      // No transactions yet
      return 0;
    }
    const row = result[0] as Record<string, unknown>;
    return Number(row.last_tx);
  }

  public async _executeQuery(
    options: DatomsParams,
    viewConfig: ViewConfig
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    if (viewConfig.type === "current") {
      return this._executeCurrentQuery(options);
    }
    if (viewConfig.type === "asOf") {
      return this._executeAsOfQuery(options, viewConfig.txId);
    }
    if (viewConfig.type === "since") {
      return this._executeSinceQuery(options, viewConfig.txId);
    }
    if (viewConfig.type === "history") {
      return this._executeHistoryQuery(options);
    }
    if (viewConfig.type === "speculative") {
      return this._executeSpeculativeQuery(options, viewConfig.datoms);
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
    await this._ensureInitialized();

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
    const aggCheck = checkSQLAggregations(modifiedQuery.find);
    const hasAggs = aggCheck.hasAggregations;
    const allAggsSupported = aggCheck.allSupported;

    // For speculative views, always use in-memory approach
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

      // Apply aggregations if needed
      if (hasAggs) {
        return applyAggregations(projected, modifiedQuery.find);
      }

      // Apply ordering if specified
      if (modifiedQuery.orderBy) {
        projected.sort((a, b) => {
          for (const [variable, direction] of modifiedQuery.orderBy!) {
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
      if (modifiedQuery.limit !== undefined) {
        return projected.slice(0, modifiedQuery.limit);
      }

      return projected;
    }

    // For non-speculative views, use the same logic as regular query() method
    // If we have unsupported aggregations, use in-memory approach
    if (hasAggs && !allAggsSupported) {
      // Use in-memory joins and aggregations
      const firstClause = modifiedQuery.where[0];
      const firstResults = await this._executeClauseWithFilteredDatoms(
        firstClause,
        afterResult.datoms
      );

      let results = firstResults;
      for (let i = 1; i < modifiedQuery.where.length; i++) {
        const clause = modifiedQuery.where[i];
        const clauseResults = await this._executeClauseWithFilteredDatoms(
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
      return this._executeDatalogWithSQL(modifiedQuery);
    }

    // Now execute the query with filtered datoms (no aggregations or single clause with supported aggregations)
    const firstClause = modifiedQuery.where[0];
    const firstResults = await this._executeClauseWithFilteredDatoms(
      firstClause,
      afterResult.datoms
    );

    let results = firstResults;
    for (let i = 1; i < modifiedQuery.where.length; i++) {
      const clause = modifiedQuery.where[i];
      const clauseResults = await this._executeClauseWithFilteredDatoms(
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
}
