/**
 * In-memory database implementation
 * Stores datoms in memory and executes queries in memory
 * Useful for testing and small datasets
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
import type { DatabaseStats, Transaction } from "../../types.js";
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
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { executeQueryOnDatoms } from "../shared/in-memory-query-executor.js";
import { joinResults, project } from "../shared/query-results.js";
import { DatabaseView, DatomsParams } from "../views/database-view.js";
import {
  ConfiguredDatabaseView,
  type InternalDatabaseView,
  type ViewConfig,
} from "../views/internal-database-view.js";

/**
 * In-memory database implementation
 * Stores datoms in memory using an array-based structure
 */
export class InMemoryDatomDatabase implements InternalDatabaseView {
  public readonly hooks: HookEngine;
  protected initialized = false;
  private _datomsArray: Datom[] = [];
  private nextTx: TransactionId = 1;
  private queryCount: number = 0;
  private transactionCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionTimeSum: number = 0;

  constructor(initialDatoms: Datom[] = []) {
    this.hooks = new HookEngine();
    this._datomsArray = initialDatoms;
    this.nextTx = Math.max(...initialDatoms.map((d) => d.tx)) + 1;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this._datomsArray = [];
      this.nextTx = 1;
      this.initialized = true;
    }
  }

  async close(): Promise<void> {
    this._datomsArray = [];
    this.initialized = false;
  }

  hook(hook: Hook): void {
    this.hooks.register(hook);
  }

  private async _writeDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = this.nextTx++;

    for (const datom of datoms) {
      this._datomsArray.push({
        e: datom.e,
        a: datom.a,
        v: datom.v,
        tx,
        op: datom.op,
      });
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

  private async _executeCurrentQuery(options: DatomsParams): Promise<Datom[]> {
    return executeQueryOnDatoms(this._datomsArray, options);
  }

  private async _executeAsOfQuery(
    options: DatomsParams,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Get all matching datoms without tx filter
    let results = this._datomsArray;

    // Apply filters (except tx, which we'll handle separately)
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }

    // Filter to only datoms with tx <= txId
    // If options.tx is specified, use the minimum of both
    const maxTx = options.tx !== undefined ? Math.min(options.tx, txId) : txId;
    results = results.filter((d) => d.tx <= maxTx);

    // Deduplicate by (entity, attribute) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const key = `${String(datom.e)}|${String(datom.a)}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out sub datoms (keep only op: "assert")
    results = Array.from(deduplicated.values()).filter(
      (d) => d.op === "assert"
    );

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  private async _executeHistoryQuery(options: DatomsParams): Promise<Datom[]> {
    await this._ensureInitialized();

    // Get all datoms matching filters without deduplication
    let results = this._datomsArray;

    // Apply filters
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

    // Sort by tx ASC for history
    results.sort((a, b) => {
      if (a.tx !== b.tx) {
        return a.tx - b.tx;
      }
      // Secondary sort by entity, then attribute
      const entityA = String(a.e);
      const entityB = String(b.e);
      if (entityA !== entityB) {
        return entityA.localeCompare(entityB);
      }
      return String(a.a).localeCompare(String(b.a));
    });

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  private async _executeSinceQuery(
    options: DatomsParams,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Get all matching datoms without tx filter
    let results = this._datomsArray;

    // Apply filters (except tx, which we'll handle separately)
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }

    // Filter to only datoms with tx > txId
    results = results.filter((d) => d.tx > txId);

    // Deduplicate by (entity, attribute, value) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const valueKey = JSON.stringify(datom.v);
      const key = `${String(datom.e)}|${String(datom.a)}|${valueKey}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out sub datoms (keep only op: "assert")
    results = Array.from(deduplicated.values()).filter(
      (d) => d.op === "assert"
    );

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
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

    // Simple implementation: for each where clause, query the database
    // and join the results
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

      // When all positions are variables, use executeHistoryQuery to bypass validation
      // then apply deduplication and filtering to get current state
      const hasAnyFilter =
        entity !== undefined || attribute !== undefined || value !== undefined;

      let clauseDatoms: Datom[];
      if (!hasAnyFilter) {
        // All variables - get all datoms without validation, then deduplicate and filter
        const rawDatoms = await this._executeHistoryQuery({});
        clauseDatoms = executeQueryOnDatoms(rawDatoms, {});
      } else {
        // Has filters - use normal datoms() method
        clauseDatoms = await this.datoms({
          e: entity,
          a: attribute,
          v: value,
        });
      }

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

    // Now execute the query with filtered datoms
    // Start with the first clause
    const firstClause = modifiedQuery.where[0];
    const firstResults = await this._executeClauseWithFilteredDatoms(
      firstClause,
      afterResult.datoms
    );

    // Join with remaining clauses
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

    // Project to find variables
    const projected = project(results, modifiedQuery.find, modifiedQuery.where);

    // Apply ordering if specified
    if (modifiedQuery.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of modifiedQuery.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit
    if (modifiedQuery.limit) {
      return projected.slice(0, modifiedQuery.limit);
    }

    return projected;
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
    // nextTx is the next transaction ID to be used, so latest is one less
    return this.nextTx > 1 ? this.nextTx - 1 : 0;
  }

  private async _recordQueryMetrics(duration: number): Promise<void> {
    this.queryCount++;
    this.queryTimeSum += duration;
  }

  private async _recordTransactionMetrics(duration: number): Promise<void> {
    this.transactionCount++;
    this.transactionTimeSum += duration;
  }

  private async _getDetailedStats(): Promise<
    Partial<
      Pick<
        DatabaseStats,
        "totalDatoms" | "totalEntities" | "queryMetrics" | "transactionMetrics"
      >
    >
  > {
    const stats: Partial<import("../../types.js").DatabaseStats> = {};

    // Count total datoms (only add ones)
    const addDatoms = this._datomsArray.filter((d) => {
      // Check if this is the latest version (not sub)
      const latestVersion = this._datomsArray
        .filter(
          (other) => other.e === d.e && other.a === d.a && other.v === d.v
        )
        .sort((a, b) => b.tx - a.tx)[0];
      return latestVersion?.op === "assert" && latestVersion.tx === d.tx;
    });
    stats.totalDatoms = addDatoms.length;

    // Count unique entities
    const uniqueEntities = new Set(addDatoms.map((d) => String(d.e)));
    stats.totalEntities = uniqueEntities.size;

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
      // Get all base datoms using _executeHistoryQuery to bypass validation
      // This returns all datoms including retracted ones, so we need to deduplicate
      const allBaseDatoms = await this._executeHistoryQuery({});

      // Create a map of base datoms by (entity, attribute, value) for efficient lookup
      // Deduplicate by keeping the latest transaction for each (entity, attribute, value)
      const baseMap = new Map<string, Datom>();
      for (const datom of allBaseDatoms) {
        const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
        const existing = baseMap.get(key);
        if (!existing || datom.tx > existing.tx) {
          baseMap.set(key, datom);
        }
      }

      // Filter to only asserted datoms (current state)
      const currentStateDatoms = Array.from(baseMap.values()).filter(
        (d) => d.op === "assert"
      );

      // Create a map for merging with speculative changes
      const mergedMap = new Map<string, Datom>();
      for (const datom of currentStateDatoms) {
        const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
        mergedMap.set(key, datom);
      }

      // Apply speculative datoms (retracts remove, asserts add/update)
      for (const speculativeDatom of viewConfig.datoms) {
        const key = `${String(speculativeDatom.e)}|${String(speculativeDatom.a)}|${JSON.stringify(speculativeDatom.v)}`;
        if (speculativeDatom.op === "retract") {
          mergedMap.delete(key);
        } else {
          mergedMap.set(key, speculativeDatom);
        }
      }

      // Create merged datoms array
      const mergedDatoms = Array.from(mergedMap.values());

      // Use the shared query execution logic
      return executeQueryOnDatoms(mergedDatoms, options);
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

    // Simple implementation: for each where clause, query the database
    // and join the results
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

      // Use executeQueryWithViewConfig instead of datoms()
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

    // Now execute the query with filtered datoms
    // Start with the first clause
    const firstClause = modifiedQuery.where[0];
    const firstResults = await this._executeClauseWithFilteredDatoms(
      firstClause,
      afterResult.datoms
    );

    // Join with remaining clauses
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

    // Project to find variables
    const projected = project(results, modifiedQuery.find, modifiedQuery.where);

    // Apply ordering if specified
    if (modifiedQuery.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of modifiedQuery.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit
    if (modifiedQuery.limit) {
      return projected.slice(0, modifiedQuery.limit);
    }

    return projected;
  }
}
