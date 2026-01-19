/**
 * HTTP client database implementation
 * Communicates with remote database server via HTTP
 */

import type { DatalogQuery, QueryClause } from "../../datalog/datalog.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  TransactionId,
  Value,
} from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import type { HttpClient } from "../../http-client/http-client.js";
import type { Transaction } from "../../types.js";
import type { DatomDatabase, WithResult } from "../datom-database.js";
import type { Hook } from "../hook/hook.js";
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
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { executeQueryOnDatoms } from "../shared/in-memory-query-executor.js";
import { joinResults, project } from "../shared/query-results.js";
import { validateQueryOptions } from "../shared/query-validation.js";
import { ConfiguredDatabaseView } from "../views/configured-database-view.js";
import type {
  DatabaseView,
  DatomsQuery,
  DatomsResultEnvelope,
  QueryResult,
  QueryResultEnvelope,
} from "../views/database-view.js";
import type { ViewConfig } from "../views/view-config.js";

interface DatomsResponse {
  datoms: Datom[];
}

interface TransactResponse {
  txId: TransactionId;
}

interface GetLatestTransactionResponse {
  txId: TransactionId;
  datoms: Datom[];
  meta?: Record<string, unknown>;
}

interface DeleteDatomsResponse {
  success: boolean;
  deleted?: number;
}

interface InitializeResponse {
  success: boolean;
}

/**
 * HTTP client database implementation
 * All operations are delegated to a remote server via HTTP
 */
export class HttpClientDatomDatabase implements DatomDatabase {
  public readonly hooks: HookEngine;
  private initialized = false;
  private currentViewConfig: ViewConfig = { type: "current" };

  constructor(
    private readonly httpClient: HttpClient,
    private readonly endpoint: string
  ) {
    this.hooks = new HookEngine();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const response = await this.httpClient.post<InitializeResponse>(
        this.endpoint,
        { method: "initialize" }
      );
      if (!response.success) {
        throw new Error("Failed to initialize remote database");
      }
      this.initialized = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize remote database: ${this._extractErrorMessage(error)}`
      );
    }
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  hook(hook: Hook): void {
    // Register hook locally only
    // Hooks run locally on HttpClientDatomDatabase, not on the remote server
    // This ensures hooks receive the HttpClientDatomDatabase instance in context, not the backend
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
    const latestTx = await this._getLatestTransaction();
    const txId = latestTx.txId! + 1;

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
      txId: txId,
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
      const response = await this.httpClient.post<TransactResponse>(
        this.endpoint,
        {
          method: "transact",
          ops: finalOps,
          metadata,
          context,
        }
      );

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
      const mappedError = this._mapHttpError(error);
      if (
        mappedError.code === "TRANSACTION_HOOK_ERROR" ||
        mappedError.code === "TRANSACTION_ERROR"
      ) {
        const errorData = mappedError.originalError as {
          errors?: Array<{ hook: string; message: string; code?: string }>;
        };
        if (errorData?.errors) {
          throw new TransactionError(mappedError.message, errorData.errors);
        }
        throw new TransactionError(mappedError.message, []);
      }
      throw new Error(`Transaction failed: ${mappedError.message}`);
    }
  }

  async _getLatestTransaction(): Promise<Transaction> {
    await this._ensureInitialized();

    try {
      const response = await this.httpClient.post<GetLatestTransactionResponse>(
        this.endpoint,
        {
          method: "getLatestTransaction",
        }
      );
      return {
        txId: response.txId,
        datoms: response.datoms,
        meta: response.meta,
      };
    } catch (error) {
      throw new Error(
        `Failed to get latest transaction: ${this._extractErrorMessage(error)}`
      );
    }
  }

  async _destroy(config: { retentionCount: number }): Promise<number> {
    await this._ensureInitialized();

    try {
      const response = await this.httpClient.post<DeleteDatomsResponse>(
        this.endpoint,
        {
          method: "deleteDatoms",
          config,
        }
      );
      return response.deleted ?? 0;
    } catch (error) {
      throw new Error(
        `Failed to delete datoms: ${this._extractErrorMessage(error)}`
      );
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
    validateQueryOptions(options);

    // Extract viewConfig from options
    const viewConfig = options.viewConfig ?? this.currentViewConfig;

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

  async query(query: DatalogQuery): Promise<QueryResult> {
    const envelope = await this.queryWithMetadata(query);
    return envelope.data;
  }

  async queryWithMetadata(query: DatalogQuery): Promise<QueryResultEnvelope> {
    // Extract context and viewConfig from query object
    const context = query.context;
    const viewConfig = query.viewConfig ?? this.currentViewConfig;
    return this._queryWithMetadataInternal(query, context, viewConfig);
  }

  private async _queryWithMetadataInternal(
    query: DatalogQuery,
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig
  ): Promise<QueryResultEnvelope> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    // Create read context
    // Extract context, but ensure db and query fields are not overwritten
    const { db: _, query: __, ...restContext } = context || {};
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

    // Run before-read hooks locally (though query executes remotely)
    // Pass enhanced query with db in context
    const beforeResult = await this.hooks.runBeforeRead(enhancedQuery, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError("Query blocked by hooks", beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query;

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

      // When all positions are variables, use _executeQuery directly with limit
      // to bypass validation, then apply deduplication and filtering
      const hasAnyFilter =
        entity !== undefined || attribute !== undefined || value !== undefined;

      let clauseDatoms: Datom[];
      if (!hasAnyFilter) {
        // All variables - get all datoms using _executeQuery with limit to satisfy validation
        // For speculative views, this will fetch all datoms and merge with speculative ones
        const rawDatoms = await this._datomsWithMetadataInternal(
          { limit: Number.MAX_SAFE_INTEGER, viewConfig },
          viewConfig
        );
        // Use shared query executor to deduplicate and filter
        clauseDatoms = executeQueryOnDatoms(rawDatoms.data, {});
      } else {
        // Has filters - use _executeQuery with viewConfig to respect time-travel views
        // Include attribute filter if specified to optimize speculative queries
        const queryOptions: DatomsQuery = {};
        if (entity !== undefined) queryOptions.e = entity;
        if (attribute !== undefined) queryOptions.a = attribute;
        if (value !== undefined) queryOptions.v = value;
        clauseDatoms = (
          await this._datomsWithMetadataInternal(queryOptions, viewConfig)
        ).data;
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
    if (!firstClause) {
      const executionTime = performance.now() - startTime;
      return {
        data: [],
        metadata: {
          executionTimeMs: executionTime,
          resultCount: 0,
          executionStrategy: "http-remote-with-hooks",
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
    let finalResult: QueryResult = projected;
    if (modifiedQuery.limit) {
      finalResult = finalResult.slice(0, modifiedQuery.limit);
    }

    const executionTime = performance.now() - startTime;
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = finalResult.length;
    metadata.executionStrategy = "http-remote-with-hooks";

    return {
      data: finalResult,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private async _datomsWithMetadataInternal(
    options: DatomsQuery,
    viewConfig: ViewConfig
  ): Promise<DatomsResultEnvelope> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    // Handle speculative queries client-side by fetching current state and merging
    let result: Datom[];
    if (viewConfig.type === "speculative") {
      result = await this._executeSpeculativeQuery(options, viewConfig.datoms);
      metadata.executionStrategy = "speculative-client-side";
    } else {
      try {
        const response = await this.httpClient.post<DatomsResponse>(
          this.endpoint,
          {
            method: "datoms",
            options,
            viewConfig,
          }
        );
        result = response.datoms;
        metadata.executionStrategy = "http-remote";
      } catch (error) {
        const mappedError = this._mapHttpError(error);
        if (mappedError.code === "QUERY_TIMEOUT") {
          throw new QueryTimeoutError(options.timeoutMs || 0, options);
        }
        if (mappedError.code === "QUERY_SAFETY_VIOLATION") {
          throw new QuerySafetyError(mappedError.message);
        }
        if (mappedError.code === "QUERY_RESULT_SIZE_EXCEEDED") {
          const errorData = mappedError.originalError as {
            resultSize?: number;
            maxResultSize?: number;
            queryOptions?: unknown;
          };
          throw new QueryResultSizeError(
            errorData.resultSize ?? 0,
            errorData.maxResultSize ?? 0,
            errorData.queryOptions ?? options
          );
        }
        throw new Error(`Query failed: ${mappedError.message}`);
      }
    }

    const executionTime = performance.now() - startTime;
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = result.length;

    return {
      data: result,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private async _executeSpeculativeQuery(
    options: DatomsQuery,
    speculativeDatoms: Datom[]
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // If no entity filter is specified, we need all datoms (for queries with all variables)
    // Otherwise, fetch only affected entities for efficiency
    const needsAllDatoms = options.e === undefined;

    let currentStateDatoms: Datom[] = [];
    if (needsAllDatoms) {
      // Fetch all current datoms from server using speculative viewConfig
      // Include attribute/value filters if specified to optimize the fetch
      // Use a large limit to satisfy validation
      const fetchOptions: DatomsQuery = { limit: Number.MAX_SAFE_INTEGER };
      if (options.a !== undefined) fetchOptions.a = options.a;
      if (options.v !== undefined) fetchOptions.v = options.v;
      try {
        const response = await this.httpClient.post<DatomsResponse>(
          this.endpoint,
          {
            method: "datoms",
            options: fetchOptions,
            viewConfig: { type: "speculative", datoms: [] },
          }
        );
        // The server returns all current datoms (filtered by options if specified)
        currentStateDatoms = response.datoms;
      } catch (error) {
        // If that fails, try fetching by affected entities as fallback
        const affectedEntities = new Set<EntityId>();
        for (const datom of speculativeDatoms) {
          affectedEntities.add(datom.e);
        }
        for (const entityId of affectedEntities) {
          try {
            const response = await this.httpClient.post<DatomsResponse>(
              this.endpoint,
              {
                method: "datoms",
                options: { e: entityId },
                viewConfig: { type: "current" },
              }
            );
            currentStateDatoms.push(...response.datoms);
          } catch {
            // Continue with other entities
          }
        }
        if (currentStateDatoms.length === 0) {
          console.warn(`Failed to fetch all current state:`, error);
        }
      }
    } else {
      // Fetch current state from remote (all datoms for affected entities)
      // We need to get all datoms that might be affected by the speculative changes
      const affectedEntities = new Set<EntityId>();
      for (const datom of speculativeDatoms) {
        affectedEntities.add(datom.e);
      }
      // Also include the entity from options if specified
      if (options.e !== undefined) {
        affectedEntities.add(options.e);
      }

      // Fetch all current datoms for affected entities
      for (const entityId of affectedEntities) {
        try {
          const response = await this.httpClient.post<DatomsResponse>(
            this.endpoint,
            {
              method: "datoms",
              options: { e: entityId },
              viewConfig: { type: "current" },
            }
          );
          currentStateDatoms.push(...response.datoms);
        } catch (error) {
          // If fetching fails, continue with speculative datoms only
          console.warn(
            `Failed to fetch current state for entity ${entityId}:`,
            error
          );
        }
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

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private _mapHttpError(error: unknown): {
    message: string;
    code?: string;
    originalError?: unknown;
  } {
    if (error instanceof Error) {
      // Try to extract error details from HTTP error message
      // HttpClient throws errors with "HTTP error! status: {status}" format
      const statusMatch = error.message.match(/status: (\d+)/);
      const status =
        statusMatch && statusMatch[1]
          ? parseInt(statusMatch[1], 10)
          : undefined;

      // Try to extract error response body if available
      let errorData: unknown = error;
      let errorMessage = error.message;
      const errorWithResponse = error as unknown as { response?: unknown };
      if (errorWithResponse.response) {
        errorData = errorWithResponse.response;
        // Extract error message from response body if available
        const errorObj = errorData as { error?: string; message?: string };
        if (errorObj?.error) {
          errorMessage = errorObj.error;
        } else if (errorObj?.message) {
          errorMessage = errorObj.message;
        }
      }

      // Map HTTP status codes to error codes
      if (status === 408) {
        return {
          message: errorMessage,
          code: "QUERY_TIMEOUT",
          originalError: errorData,
        };
      }
      if (status === 400) {
        // Try to determine specific error type from error data
        const errorObj = errorData as {
          code?: string;
          error?: string;
          errors?: Array<{ hook: string; message: string; code?: string }>;
        };
        if (errorObj?.code === "QUERY_SAFETY_VIOLATION") {
          return {
            message: errorMessage,
            code: "QUERY_SAFETY_VIOLATION",
            originalError: errorData,
          };
        }
        if (errorObj?.code === "QUERY_RESULT_SIZE_EXCEEDED") {
          return {
            message: errorMessage,
            code: "QUERY_RESULT_SIZE_EXCEEDED",
            originalError: errorData,
          };
        }
        if (
          errorObj?.code === "TRANSACTION_HOOK_ERROR" ||
          errorObj?.code === "TRANSACTION_ERROR"
        ) {
          return {
            message: errorMessage,
            code: "TRANSACTION_HOOK_ERROR",
            originalError: errorData,
          };
        }
        if (
          errorObj?.code === "QUERY_HOOK_ERROR" ||
          errorObj?.code === "QUERY_ERROR"
        ) {
          return {
            message: errorMessage,
            code: "QUERY_HOOK_ERROR",
            originalError: errorData,
          };
        }
        return {
          message: errorMessage,
          code: "DATABASE_ERROR",
          originalError: errorData,
        };
      }
      if (status === 500) {
        return {
          message: errorMessage,
          code: "DATABASE_ERROR",
          originalError: errorData,
        };
      }

      // Default: map to DATABASE_ERROR
      return {
        message: errorMessage,
        code: "DATABASE_ERROR",
        originalError: errorData,
      };
    }

    return {
      message: String(error),
      code: "DATABASE_ERROR",
      originalError: error,
    };
  }

  private _extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
