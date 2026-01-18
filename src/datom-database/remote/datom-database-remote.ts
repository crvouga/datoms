/**
 * Remote database implementation
 * Delegates all operations to a remote server via ITransport abstraction
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Datom, DatomInput, TransactionId, Value } from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import {
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
import type { Transaction } from "../../types.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import { executeQueryOnDatoms } from "../shared/in-memory-query-executor.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { joinResults, project } from "../shared/query-results.js";
import type { QueryClause } from "../../datalog/datalog.js";
import type { Attribute } from "../../datoms.js";
import { DatabaseView, DatomsParams } from "../views/database-view.js";
import {
  ConfiguredDatabaseView,
  type InternalDatabaseView,
  type ViewConfig,
} from "../views/internal-database-view.js";
import type { WithResult } from "../datom-database.js";
import type { Hook } from "../hook/hook.js";
import { ITransport, TransportError } from "./transport/transport.js";
import type {
  DatomsRequest,
  DatomsResponse,
  QueryRequest,
  QueryResponse,
  TransactRequest,
  TransactResponse,
  GetLatestTransactionRequest,
  GetLatestTransactionResponse,
  GetTransactionMetadataRequest,
  GetTransactionMetadataResponse,
  InitializeRequest,
  InitializeResponse,
} from "./transport/types.js";

/**
 * Remote database implementation
 * All operations are delegated to a remote server via ITransport
 */
export class RemoteDatomDatabase implements InternalDatabaseView {
  public readonly hooks: HookEngine;
  private initialized = false;
  private currentViewConfig: ViewConfig = { type: "current" };

  constructor(private transport: ITransport) {
    this.hooks = new HookEngine();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const request: InitializeRequest = { method: "initialize" };
      const response = await this.transport.request<
        InitializeRequest,
        InitializeResponse
      >("initialize", request);
      if (!response.success) {
        throw new Error("Failed to initialize remote database");
      }
      this.initialized = true;
    } catch (error) {
      if (error instanceof TransportError) {
        throw new Error(
          `Failed to initialize remote database: ${error.message}`
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.initialized = false;
  }

  hook(hook: Hook): void {
    // Register hook locally only
    // Hooks run locally on RemoteDatomDatabase, not on the remote server
    // This ensures hooks receive the RemoteDatomDatabase instance in context, not the backend
    this.hooks.register(hook);
  }

  async transact(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId> {
    await this._ensureInitialized();

    // Create write context for hooks
    const ctx: WriteContext = {
      db: this,
      txMeta: metadata,
      ...(context || {}),
    };

    // Flatten ops and convert to datoms for transaction object
    const flatOps = ops.flat();
    const latestTx = await this.getLatestTransaction();
    const txId = latestTx + 1;

    // Convert ops to datoms for transaction object
    const datoms: Datom[] = flatOps.map((op) => ({
      e: op.e,
      a: op.a,
      v: op.v,
      tx: txId,
      op: op.op,
    }));

    // Create transaction object for hooks
    const tx: Transaction = {
      datoms,
      meta: metadata,
    };

    // Run before-write hooks locally
    const beforeResult = await this.hooks.runBeforeWrite(tx, ctx);

    if (beforeResult.errors && beforeResult.errors.length > 0) {
      throw new TransactionError(
        "Transaction validation failed",
        beforeResult.errors
      );
    }

    // Use the modified transaction from hooks
    const finalTx = beforeResult.tx;
    const finalOps = finalTx.datoms.map((d) => ({
      e: d.e,
      a: d.a,
      v: d.v,
      op: d.op,
    }));

    try {
      const request: TransactRequest = {
        method: "transact",
        ops: finalOps,
        metadata,
        context,
      };
      const response = await this.transport.request<
        TransactRequest,
        TransactResponse
      >("transact", request);

      // Create write result for after-write hooks
      const writeResult: WriteResult = {
        txId: response.txId,
        datoms: finalTx.datoms.map((d) => ({ ...d, tx: response.txId })),
        timestamp: Date.now(),
      };

      // Run after-write hooks locally (fire and forget, don't block)
      this.hooks.runAfterWrite(writeResult, ctx).catch((err) => {
        console.error("After-write hook failed:", err);
      });

      return response.txId;
    } catch (error) {
      if (error instanceof TransportError) {
        // Try to map transport error to transaction error
        if (
          error.code === "TRANSACTION_HOOK_ERROR" ||
          error.code === "TRANSACTION_ERROR"
        ) {
          // Parse error details if available
          const errorData = error.originalError as {
            errors?: Array<{ hook: string; message: string; code?: string }>;
          };
          if (errorData?.errors) {
            throw new TransactionError(error.message, errorData.errors);
          }
          throw new TransactionError(error.message, []);
        }
        throw new Error(`Transaction failed: ${error.message}`);
      }
      throw error;
    }
  }

  async onTransactionMetadata(
    _txId: TransactionId,
    _metadata: Record<string, unknown>
  ): Promise<void> {
    // Metadata is stored remotely, no local action needed
  }

  async getTransactionMetadata(
    txId: TransactionId
  ): Promise<Record<string, unknown> | undefined> {
    await this._ensureInitialized();

    try {
      const request: GetTransactionMetadataRequest = {
        method: "getTransactionMetadata",
        txId,
      };
      const response = await this.transport.request<
        GetTransactionMetadataRequest,
        GetTransactionMetadataResponse
      >("getTransactionMetadata", request);
      return response.metadata;
    } catch (error) {
      if (error instanceof TransportError) {
        throw new Error(`Failed to get transaction metadata: ${error.message}`);
      }
      throw error;
    }
  }

  async getLatestTransaction(): Promise<TransactionId> {
    await this._ensureInitialized();

    try {
      const request: GetLatestTransactionRequest = {
        method: "getLatestTransaction",
      };
      const response = await this.transport.request<
        GetLatestTransactionRequest,
        GetLatestTransactionResponse
      >("getLatestTransaction", request);
      return response.txId;
    } catch (error) {
      if (error instanceof TransportError) {
        throw new Error(`Failed to get latest transaction: ${error.message}`);
      }
      throw error;
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
    validateQueryOptions(options);

    // Execute query with timeout if specified
    let results: Datom[];
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new QueryTimeoutError(options.timeoutMs!, options));
        }, options.timeoutMs);
      });

      const queryPromise = this._executeQuery(options, this.currentViewConfig);
      results = await Promise.race([queryPromise, timeoutPromise]);
    } else {
      results = await this._executeQuery(options, this.currentViewConfig);
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

    // Run before-read hooks locally (though they execute remotely)
    const beforeResult = await this.hooks.runBeforeRead(query, ctx);

    if (beforeResult.errors && beforeResult.errors.length > 0) {
      throw new QueryError("Query blocked by hooks", beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query || query;

    // Return empty result if where clause is empty
    if (modifiedQuery.where.length === 0) {
      return [];
    }

    try {
      const request: QueryRequest = {
        method: "query",
        query: modifiedQuery,
        context,
        viewConfig: this.currentViewConfig,
      };
      // Note: We don't use the remote response directly because we need to
      // re-execute the query with filtered datoms from after-read hooks
      await this.transport.request<QueryRequest, QueryResponse>(
        "query",
        request
      );

      // Fetch datoms for after-read hooks
      // Extract datoms from all query clauses
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

        // When all positions are variables, use _executeQuery directly with limit
        // to bypass validation, then apply deduplication and filtering
        const hasAnyFilter =
          entity !== undefined ||
          attribute !== undefined ||
          value !== undefined;

        let clauseDatoms: Datom[];
        if (!hasAnyFilter) {
          // All variables - get all datoms using _executeQuery with limit to satisfy validation
          const rawDatoms = await this._executeQuery(
            { limit: Number.MAX_SAFE_INTEGER },
            this.currentViewConfig
          );
          // Use shared query executor to deduplicate and filter
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

      // Run after-read hooks locally
      const afterResult = await this.hooks.runAfterRead(allDatoms, ctx);

      if (afterResult.errors && afterResult.errors.length > 0) {
        throw new QueryError(
          "Query blocked by after-read hooks",
          afterResult.errors
        );
      }

      // Re-execute query with filtered datoms from hooks
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
      const projected = project(
        results,
        modifiedQuery.find,
        modifiedQuery.where
      );

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
    } catch (error) {
      if (error instanceof TransportError) {
        error.toQueryError(query);
      }
      throw error;
    }
  }

  async _executeQuery(
    options: DatomsParams,
    viewConfig: ViewConfig
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Handle speculative queries client-side by fetching current state and merging
    if (viewConfig.type === "speculative") {
      return this._executeSpeculativeQuery(options, viewConfig.datoms);
    }

    try {
      const request: DatomsRequest = {
        method: "datoms",
        options,
        viewConfig,
      };
      const response = await this.transport.request<
        DatomsRequest,
        DatomsResponse
      >("datoms", request);
      return response.datoms;
    } catch (error) {
      if (error instanceof TransportError) {
        if (error.code === "QUERY_TIMEOUT") {
          throw new QueryTimeoutError(options.timeoutMs || 0, options);
        }
        if (error.code === "QUERY_SAFETY_VIOLATION") {
          throw new QuerySafetyError(error.message);
        }
        throw new Error(`Query failed: ${error.message}`);
      }
      throw error;
    }
  }

  private async _executeSpeculativeQuery(
    options: DatomsParams,
    speculativeDatoms: Datom[]
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Fetch current state from remote (all datoms for affected entities)
    // We need to get all datoms that might be affected by the speculative changes
    const affectedEntities = new Set<EntityId>();
    for (const datom of speculativeDatoms) {
      affectedEntities.add(datom.e);
    }

    // Fetch all current datoms for affected entities
    const currentStateDatoms: Datom[] = [];
    for (const entityId of affectedEntities) {
      try {
        const request: DatomsRequest = {
          method: "datoms",
          options: { e: entityId },
          viewConfig: { type: "current" },
        };
        const response = await this.transport.request<
          DatomsRequest,
          DatomsResponse
        >("datoms", request);
        currentStateDatoms.push(...response.datoms);
      } catch (error) {
        // If fetching fails, continue with speculative datoms only
        console.warn(
          `Failed to fetch current state for entity ${entityId}:`,
          error
        );
      }
    }

    // Create a map for merging with speculative changes
    // Use (entity, attribute, value) as key to support multi-valued attributes
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

  async _executeDatalogQuery(
    query: DatalogQuery,
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig
  ): Promise<QueryResult> {
    await this._ensureInitialized();

    // Handle speculative queries client-side
    if (viewConfig.type === "speculative") {
      // For speculative datalog queries, we need to fetch current state
      // and merge with speculative datoms, then execute query locally
      // This is complex, so for now we'll delegate to remote with speculative datoms
      // The remote server should handle this, but if not supported, we can implement client-side
    }

    // Create read context
    const ctx: ReadContext = {
      db: this,
      ...(context || {}),
    };

    // Run before-read hooks locally
    const beforeResult = await this.hooks.runBeforeRead(query, ctx);

    if (beforeResult.errors && beforeResult.errors.length > 0) {
      throw new QueryError("Query blocked by hooks", beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query || query;

    try {
      const request: QueryRequest = {
        method: "query",
        query: modifiedQuery,
        context,
        viewConfig,
      };
      const response = await this.transport.request<
        QueryRequest,
        QueryResponse
      >("query", request);
      return response.results;
    } catch (error) {
      if (error instanceof TransportError) {
        if (error.code === "QUERY_HOOK_ERROR" || error.code === "QUERY_ERROR") {
          const errorData = error.originalError as {
            errors?: Array<{ hook: string; message: string; code?: string }>;
          };
          if (errorData?.errors) {
            throw new QueryError(error.message, errorData.errors);
          }
          throw new QueryError(error.message, []);
        }
        if (error.code === "QUERY_TIMEOUT") {
          throw new QueryTimeoutError(0, query);
        }
        throw new QueryError(`Query failed: ${error.message}`, []);
      }
      throw error;
    }
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
