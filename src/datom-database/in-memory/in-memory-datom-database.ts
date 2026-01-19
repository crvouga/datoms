/**
 * In-memory database implementation
 * Stores datoms in memory and executes queries in memory
 * Useful for testing and small datasets
 */

import type {
  DatalogQuery,
  DatalogQueryFindVariable,
  QueryClause,
} from "../../datalog/datalog.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  TransactionId,
  Value,
} from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import type { Transaction } from "../../types.js";
import type { DatomDatabase, WithResult } from "../datom-database.js";
import {
  HookEngine,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionError,
  type Hook,
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
import { ConfiguredDatabaseView } from "../views/configured-database-view.js";
import type {
  DatabaseView,
  DatomsQuery,
  DatomsResultEnvelope,
  QueryResult,
  QueryResultEnvelope,
} from "../views/database-view.js";
import type { ViewConfig } from "../views/view-config.js";

/**
 * In-memory database implementation
 * Stores datoms in memory using an array-based structure
 */
export class InMemoryDatomDatabase implements DatomDatabase {
  public readonly hooks: HookEngine;
  protected initialized = false;
  protected _datomsArray: Datom[] = [];
  private _initialDatoms: Datom[] = [];
  protected nextTx: TransactionId = 1;

  constructor(initialDatoms: Datom[] = []) {
    this.hooks = new HookEngine();
    this._datomsArray = initialDatoms;
    this._initialDatoms = initialDatoms;
    this.nextTx = Math.max(...initialDatoms.map((d) => d.tx)) + 1;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this._datomsArray = this._initialDatoms;
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
    const latestTx = await this._getLatestTransaction();
    const txId = latestTx.txId! + 1;

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
      txId: txId,
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
    const speculativeTxId = (await this._getLatestTransaction()).txId! + 1;

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

  async datoms(query: DatomsQuery): Promise<Datom[]> {
    const envelope = await this.datomsWithMetadata(query);
    return envelope.data;
  }

  async datomsWithMetadata(
    options: DatomsQuery
  ): Promise<DatomsResultEnvelope> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined ||
      options.txMax !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx, txMax) or a limit to prevent full table scans"
      );
    }

    // Extract viewConfig from options
    const viewConfig = options.viewConfig ?? { type: "current" };

    // Execute query with timeout if specified
    let envelope: DatomsResultEnvelope;
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new QueryTimeoutError(options.timeoutMs!, options));
        }, options.timeoutMs);
      });

      const queryPromise = this._datomsWithMetadataInternal(
        options,
        viewConfig
      );
      envelope = await Promise.race([queryPromise, timeoutPromise]);
    } else {
      envelope = await this._datomsWithMetadataInternal(options, viewConfig);
    }

    // Check result size limit if specified
    if (
      options.maxResultSize !== undefined &&
      envelope.data.length > options.maxResultSize
    ) {
      throw new QueryResultSizeError(
        envelope.data.length,
        options.maxResultSize,
        options
      );
    }

    return envelope;
  }

  private async _executeCurrentQuery(options: DatomsQuery): Promise<Datom[]> {
    return executeQueryOnDatoms(this._datomsArray, options);
  }

  private async _executeAsOfQuery(
    options: DatomsQuery,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Validate that tx and txMax are mutually exclusive
    if (options.tx !== undefined && options.txMax !== undefined) {
      throw new Error(
        "Cannot specify both tx and txMax parameters - they are mutually exclusive"
      );
    }

    // Get all matching datoms without tx filter
    let results = this._datomsArray;

    // Apply filters (except tx/txMax, which we'll handle separately)
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
    // If options.txMax is specified, use the minimum of txMax and txId
    let maxTx = txId;
    if (options.tx !== undefined) {
      maxTx = Math.min(options.tx, txId);
    } else if (options.txMax !== undefined) {
      maxTx = Math.min(options.txMax, txId);
    }
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

  private async _executeHistoryQuery(options: DatomsQuery): Promise<Datom[]> {
    await this._ensureInitialized();

    // Validate that tx and txMax are mutually exclusive
    if (options.tx !== undefined && options.txMax !== undefined) {
      throw new Error(
        "Cannot specify both tx and txMax parameters - they are mutually exclusive"
      );
    }

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
    if (options.txMax !== undefined) {
      const txMax = options.txMax;
      results = results.filter((d) => d.tx <= txMax);
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
    options: DatomsQuery,
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

  private async _executeSpeculativeQuery(
    options: DatomsQuery,
    speculativeDatoms: Datom[]
  ): Promise<Datom[]> {
    await this._ensureInitialized();

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
    for (const speculativeDatom of speculativeDatoms) {
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

  async query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    query: DatalogQuery<keyof TFind & string> & { find: TFind }
  ): Promise<QueryResult<TFind>> {
    const envelope = await this.queryWithMetadata(query);
    return envelope.data;
  }

  async queryWithMetadata<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    query: DatalogQuery<keyof TFind & string> & { find: TFind }
  ): Promise<QueryResultEnvelope<TFind>> {
    // Extract viewConfig from query
    const viewConfig = query.viewConfig ?? { type: "current" };
    return this._queryWithMetadataInternal(query, viewConfig);
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

  async _getLatestTransaction(): Promise<Transaction> {
    await this._ensureInitialized();
    // nextTx is the next transaction ID to be used, so latest is one less
    const txId = this.nextTx > 1 ? this.nextTx - 1 : 0;

    if (txId === 0) {
      return { txId: 0, datoms: [], meta: undefined };
    }

    // Get all datoms for this transaction using history view
    const datoms = await this._executeHistoryQuery({ tx: txId });

    return {
      txId,
      datoms,
      meta: undefined, // Metadata is not persisted in in-memory implementation
    };
  }

  async _destroy(config: { retentionCount: number }): Promise<number> {
    await this._ensureInitialized();

    if (config.retentionCount < 1) {
      throw new Error(
        "retentionCount must be at least 1 to ensure at least one datom is kept per (entity, attribute) pair"
      );
    }

    // Group datoms by (e, a) pairs
    const datomsByEntityAttribute = new Map<string, Datom[]>();
    for (const datom of this._datomsArray) {
      const key = `${String(datom.e)}|${String(datom.a)}`;
      if (!datomsByEntityAttribute.has(key)) {
        datomsByEntityAttribute.set(key, []);
      }
      datomsByEntityAttribute.get(key)!.push(datom);
    }

    // For each (e, a) pair, keep only the latest N datoms
    const datomsToDelete = new Set<string>();
    for (const [, groupDatoms] of datomsByEntityAttribute.entries()) {
      // Sort by transaction ID descending (latest first)
      groupDatoms.sort((a, b) => b.tx - a.tx);

      // If this group has more than retentionCount datoms, mark the excess for deletion
      if (groupDatoms.length > config.retentionCount) {
        // Keep first N datoms (indices 0 to retentionCount-1)
        // Delete the rest (indices retentionCount onwards)
        for (let i = config.retentionCount; i < groupDatoms.length; i++) {
          const datom = groupDatoms[i];
          if (datom) {
            const deleteKey = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}|${datom.tx}|${datom.op}`;
            datomsToDelete.add(deleteKey);
          }
        }
      }
    }

    // Remove datoms marked for deletion
    const beforeLength = this._datomsArray.length;
    this._datomsArray = this._datomsArray.filter((datom) => {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}|${datom.tx}|${datom.op}`;
      return !datomsToDelete.has(key);
    });

    return beforeLength - this._datomsArray.length;
  }

  /**
   * Compute obsolete datoms from a list of datoms.
   * A datom is obsolete if it has been superseded by a later transaction for the same (entity, attribute, value).
   * @param datoms Array of datoms to analyze
   * @returns Array of obsolete datoms (all datoms that are not the latest for their (e, a, v) group)
   */
  private _computeObsoleteDatoms(datoms: Datom[]): Datom[] {
    // Group datoms by (entity, attribute, value)
    const datomsByKey = new Map<string, Datom[]>();
    for (const datom of datoms) {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
      if (!datomsByKey.has(key)) {
        datomsByKey.set(key, []);
      }
      datomsByKey.get(key)!.push(datom);
    }

    // For each (e, a, v) group, find the latest transaction
    // All datoms with tx < latestTx are obsolete
    const obsoleteDatoms: Datom[] = [];
    for (const [_key, groupDatoms] of datomsByKey.entries()) {
      if (groupDatoms.length === 0) {
        continue;
      }

      // Sort by transaction ID descending
      groupDatoms.sort((a, b) => b.tx - a.tx);

      // Get the latest transaction ID for this (e, a, v)
      const latestDatom = groupDatoms[0];
      if (!latestDatom) {
        continue;
      }

      // All datoms with tx < latestTx are obsolete (they've been superseded)
      for (let i = 1; i < groupDatoms.length; i++) {
        const datom = groupDatoms[i];
        if (datom) {
          obsoleteDatoms.push(datom);
        }
      }
    }

    // Remove duplicates using a unique key
    const uniqueObsolete = new Map<string, Datom>();
    for (const datom of obsoleteDatoms) {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}|${datom.tx}|${datom.op}`;
      uniqueObsolete.set(key, datom);
    }

    return Array.from(uniqueObsolete.values());
  }

  private async _datomsWithMetadataInternal(
    options: DatomsQuery,
    viewConfig: ViewConfig
  ): Promise<DatomsResultEnvelope> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    let result: Datom[];

    if (viewConfig.type === "current") {
      result = await this._executeCurrentQuery(options);
    } else if (viewConfig.type === "asOf") {
      result = await this._executeAsOfQuery(options, viewConfig.txId);
    } else if (viewConfig.type === "since") {
      result = await this._executeSinceQuery(options, viewConfig.txId);
    } else if (viewConfig.type === "history") {
      result = await this._executeHistoryQuery(options);
    } else if (viewConfig.type === "speculative") {
      result = await this._executeSpeculativeQuery(options, viewConfig.datoms);
    } else {
      // TypeScript exhaustiveness check
      const _exhaustive: never = viewConfig;
      throw new Error(
        `Unknown view config type: ${(_exhaustive as ViewConfig).type}`
      );
    }

    const executionTime = performance.now() - startTime;
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = result.length;
    metadata.executionStrategy = "in-memory";

    return {
      data: result,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private async _queryWithMetadataInternal<
    TFind extends Record<string, DatalogQueryFindVariable>,
  >(
    query: DatalogQuery<keyof TFind & string> & { find: TFind },
    viewConfig: ViewConfig
  ): Promise<QueryResultEnvelope<TFind>> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    // Create read context
    // Extract context from query, but ensure db and query fields are not overwritten
    const { db: _, query: __, ...restContext } = query.context || {};
    // Merge db into query.context so hooks can access it via query.context.db
    const enhancedQuery = {
      ...query,
      context: {
        ...restContext,
        db: this,
      },
    };
    const ctx: ReadContext = {
      ...restContext,
      db: this,
      query: enhancedQuery,
    };

    // Run before-read hooks (pass enhanced query with db in context)
    const beforeResult = await this.hooks.runBeforeRead(enhancedQuery, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError("Query blocked by hooks", beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query;
    // Extract viewConfig from modified query if it was changed
    const finalViewConfig = modifiedQuery.viewConfig ?? viewConfig;

    // Simple implementation: for each where clause, query the database
    // and join the results
    if (modifiedQuery.where.length === 0) {
      const executionTime = performance.now() - startTime;
      return {
        data: [],
        metadata: {
          executionTimeMs: executionTime,
          resultCount: 0,
        },
      };
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

      // Use internal method with finalViewConfig
      const clauseDatoms = await this._datomsWithMetadataInternal(
        {
          e: entity,
          a: attribute,
          v: value,
          viewConfig: finalViewConfig,
        },
        finalViewConfig
      );

      for (const datom of clauseDatoms.data) {
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
    if (!firstClause) {
      const executionTime = performance.now() - startTime;
      return {
        data: [],
        metadata: {
          executionTimeMs: executionTime,
          resultCount: 0,
          executionStrategy: "in-memory-filtered-datoms",
        },
      };
    }
    const firstResults = await this._executeClauseWithFilteredDatoms(
      firstClause,
      afterResult.datoms
    );

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < modifiedQuery.where.length; i++) {
      const clause = modifiedQuery.where[i];
      if (!clause) continue;
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
      // Map orderBy variables to output keys from find clause
      const variableToOutputKey = new Map<string, string>();
      for (const [outputKey, expr] of Object.entries(modifiedQuery.find)) {
        let varName: string | undefined;
        if (
          Array.isArray(expr) &&
          expr.length === 1 &&
          typeof expr[0] === "string"
        ) {
          varName = expr[0];
        } else if (typeof expr === "string") {
          varName = expr;
        }
        if (varName) {
          variableToOutputKey.set(varName, outputKey);
        }
      }

      projected.sort((a, b) => {
        for (const [variable, direction] of modifiedQuery.orderBy!) {
          // Map variable to output key, or fall back to stripped variable name
          const outputKey =
            variableToOutputKey.get(variable) ?? stripQuestionMark(variable);
          const aVal = a[outputKey];
          const bVal = b[outputKey];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          // Ensure proper numeric comparison when both values are numeric
          // This handles cases where numeric values might be stored as strings
          let comparison: number;

          // Check if both values can be treated as numbers
          const aIsNumber = typeof aVal === "number";
          const bIsNumber = typeof bVal === "number";

          let aNum: number | null = null;
          let bNum: number | null = null;

          if (aIsNumber) {
            aNum = aVal;
          } else if (typeof aVal === "string" && aVal !== "") {
            const parsed = Number(aVal);
            if (!isNaN(parsed) && isFinite(parsed)) {
              aNum = parsed;
            }
          }

          if (bIsNumber) {
            bNum = bVal;
          } else if (typeof bVal === "string" && bVal !== "") {
            const parsed = Number(bVal);
            if (!isNaN(parsed) && isFinite(parsed)) {
              bNum = parsed;
            }
          }

          // If both are numeric, compare as numbers
          if (aNum !== null && bNum !== null) {
            comparison = aNum - bNum;
          } else {
            // At least one is not numeric, use locale-aware string comparison
            // Convert to strings to ensure consistent comparison (matching test expectations)
            const aStr = String(aVal);
            const bStr = String(bVal);
            comparison = aStr.localeCompare(bStr);
          }

          if (comparison !== 0) {
            return direction === "asc" ? comparison : -comparison;
          }
        }
        return 0;
      });
    }

    // Apply limit
    let finalResult: QueryResult<TFind> = projected as QueryResult<TFind>;
    if (modifiedQuery.limit) {
      finalResult = finalResult.slice(
        0,
        modifiedQuery.limit
      ) as QueryResult<TFind>;
    }

    const executionTime = performance.now() - startTime;
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = finalResult.length;
    metadata.executionStrategy = "in-memory-filtered-datoms";

    return {
      data: finalResult,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
}
