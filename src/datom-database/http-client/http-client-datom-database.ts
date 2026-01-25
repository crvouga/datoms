/**
 * HTTP client database implementation
 * Communicates with remote database server via HTTP
 * Pure transport layer - all query logic handled server-side
 */

import type {DatalogQuery, DatalogQueryFindVariable} from '../../datalog-query.js';
import type {Datom, DatomInput, TransactionId} from '../../datoms.js';
import type {HttpClient} from '../../http-client/http-client.js';
import type {Transaction} from '../../types.js';
import type {DatomDatabase, WithResult} from '../datom-database.js';
import type {Hook} from '../hook/hook.js';
import {
  HookEngine,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  type ReadContext,
  TransactionError,
  type WriteContext,
  type WriteResult,
} from '../hook/hook.js';
import {ConfiguredDatomDatabaseView} from '../views/configured-datom-database-view.js';
import type {DatomDatabaseView, QueryResult, QueryResultEnvelope} from '../datom-database-view.js';
import type {ViewConfig} from '../views/view-config.js';
import type {
  DeleteDatomsResponse,
  GetLatestTransactionResponse,
  InitializeResponse,
  QueryResponse,
  TransactResponse,
} from './http-client-transport-types.js';

/**
 * HTTP client database implementation
 * All operations are delegated to a remote server via HTTP
 * This is a pure transport layer - no query logic or local datom fetching
 */
export class HttpClientDatomDatabase implements DatomDatabase {
  public readonly hooks: HookEngine;
  private initialized = false;
  private currentViewConfig: ViewConfig = {type: 'current'};

  constructor(
    private readonly httpClient: HttpClient,
    private readonly endpoint: string,
  ) {
    this.hooks = new HookEngine();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const response = await this.httpClient.post<InitializeResponse>(this.endpoint, {
        method: 'initialize',
      });
      if (!response.success) {
        throw new Error('Failed to initialize remote database');
      }
      this.initialized = true;
    } catch (error) {
      throw new Error(`Failed to initialize remote database: ${this._extractErrorMessage(error)}`);
    }
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
    context?: Record<string, unknown>,
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
    const txId = Number(latestTx.txId) + 1;

    // Convert ops to datoms for transaction object
    const datoms: Datom[] = flatOps.map(op => ({
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
      throw new TransactionError('Transaction validation failed', beforeResult.errors);
    }

    // Use the modified transaction from hooks
    const finalTx = beforeResult.tx;
    const finalOps = finalTx.datoms.map(d => ({
      e: d.e,
      a: d.a,
      v: d.v,
      op: d.op,
    }));

    try {
      const response = await this.httpClient.post<TransactResponse>(this.endpoint, {
        method: 'transact',
        ops: finalOps,
        metadata,
        context,
      });

      // Create write result for after-write hooks
      const writeResult: WriteResult = {
        txId: response.txId,
        datoms: finalTx.datoms.map(d => ({...d, tx: response.txId})),
        timestamp: Date.now(),
      };

      // Run after-write hooks locally (fire and forget, don't block)
      this.hooks.runAfterWrite(writeResult, ctx).catch(err => {
        console.error('After-write hook failed:', err);
      });

      return response.txId;
    } catch (error) {
      const mappedError = this._mapHttpError(error);
      if (
        mappedError.code === 'TRANSACTION_HOOK_ERROR' ||
        mappedError.code === 'TRANSACTION_ERROR'
      ) {
        const errorData = mappedError.originalError as {
          errors?: Array<{hook: string; message: string; code?: string}>;
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
      const response = await this.httpClient.post<GetLatestTransactionResponse>(this.endpoint, {
        method: 'getLatestTransaction',
      });
      return {
        txId: response.txId,
        datoms: response.datoms,
        meta: response.meta,
      };
    } catch (error) {
      throw new Error(`Failed to get latest transaction: ${this._extractErrorMessage(error)}`);
    }
  }

  async _destroy(config: {retentionCount: number}): Promise<number> {
    await this._ensureInitialized();

    try {
      const response = await this.httpClient.post<DeleteDatomsResponse>(this.endpoint, {
        method: 'deleteDatoms',
        config,
      });
      return response.deleted ?? 0;
    } catch (error) {
      throw new Error(`Failed to delete datoms: ${this._extractErrorMessage(error)}`);
    }
  }

  asOf(txId: TransactionId): DatomDatabaseView {
    return new ConfiguredDatomDatabaseView(this, {type: 'asOf', txId});
  }

  history(): DatomDatabaseView {
    return new ConfiguredDatomDatabaseView(this, {type: 'history'});
  }

  since(txId: TransactionId): DatomDatabaseView {
    return new ConfiguredDatomDatabaseView(this, {type: 'since', txId});
  }

  async with(ops: DatomInput[]): Promise<WithResult> {
    await this._ensureInitialized();

    // Get the next transaction ID for speculative datoms
    // biome-ignore lint/style/noNonNullAssertion: txId is guaranteed to exist for latest transaction
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
    const dbBefore = new ConfiguredDatomDatabaseView(this, {type: 'current'});

    // Create dbAfter view (speculative state)
    // Server will handle speculative query execution
    const dbAfter = new ConfiguredDatomDatabaseView(this, {
      type: 'speculative',
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

  async query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
  ): Promise<QueryResultEnvelope<TFind>> {
    await this._ensureInitialized();

    // Extract context and viewConfig from query object
    const context = query.context;
    const viewConfig = query.viewConfig ?? this.currentViewConfig;

    // Create read context for hooks
    // Extract context, but ensure db and query fields are not overwritten
    const {db: _, query: __, ...restContext} = context || {};
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

    // Run before-read hooks locally (query will execute remotely)
    const beforeResult = await this.hooks.runBeforeRead(enhancedQuery, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError('Query blocked by hooks', beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query as DatalogQuery<keyof TFind & string> & {find: TFind};

    // Forward modified query to server - server handles timeout and result size validation
    const results = await this._queryInternal(modifiedQuery, context, viewConfig);

    // Run after-read hooks on QueryResult
    const afterResult = await this.hooks.runAfterRead(results, ctx);

    if (afterResult.errors.length > 0) {
      throw new QueryError('Query blocked by after-read hooks', afterResult.errors);
    }

    return {
      data: afterResult.results,
    };
  }

  private async _queryInternal<TFind extends Record<string, DatalogQueryFindVariable>>(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig,
  ): Promise<QueryResult<TFind>> {
    try {
      const response = await this.httpClient.post<QueryResponse>(this.endpoint, {
        method: 'query',
        query,
        context,
        viewConfig,
      });
      // Server returns QueryResult which matches our expected type
      return response.results as unknown as QueryResult<TFind>;
    } catch (error) {
      const mappedError = this._mapHttpError(error);
      if (mappedError.code === 'QUERY_TIMEOUT') {
        throw new QueryTimeoutError(0, query as unknown);
      }
      if (mappedError.code === 'QUERY_SAFETY_VIOLATION') {
        throw new QuerySafetyError(mappedError.message);
      }
      if (mappedError.code === 'QUERY_RESULT_SIZE_EXCEEDED') {
        const errorData = mappedError.originalError as {
          resultSize?: number;
          maxResultSize?: number;
          queryOptions?: unknown;
        };
        throw new QueryResultSizeError(
          errorData.resultSize ?? 0,
          errorData.maxResultSize ?? 0,
          errorData.queryOptions ?? query,
        );
      }
      throw new Error(`Query failed: ${mappedError.message}`);
    }
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
      const status = statusMatch?.[1] ? Number.parseInt(statusMatch[1], 10) : undefined;

      // Try to extract error response body if available
      let errorData: unknown = error;
      let errorMessage = error.message;
      const errorWithResponse = error as unknown as {response?: unknown};
      if (errorWithResponse.response) {
        errorData = errorWithResponse.response;
        // Extract error message from response body if available
        const errorObj = errorData as {error?: string; message?: string};
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
          code: 'QUERY_TIMEOUT',
          originalError: errorData,
        };
      }
      if (status === 400) {
        // Try to determine specific error type from error data
        const errorObj = errorData as {
          code?: string;
          error?: string;
          errors?: Array<{hook: string; message: string; code?: string}>;
        };
        if (errorObj?.code === 'QUERY_SAFETY_VIOLATION') {
          return {
            message: errorMessage,
            code: 'QUERY_SAFETY_VIOLATION',
            originalError: errorData,
          };
        }
        if (errorObj?.code === 'QUERY_RESULT_SIZE_EXCEEDED') {
          return {
            message: errorMessage,
            code: 'QUERY_RESULT_SIZE_EXCEEDED',
            originalError: errorData,
          };
        }
        if (errorObj?.code === 'TRANSACTION_HOOK_ERROR' || errorObj?.code === 'TRANSACTION_ERROR') {
          return {
            message: errorMessage,
            code: 'TRANSACTION_HOOK_ERROR',
            originalError: errorData,
          };
        }
        if (errorObj?.code === 'QUERY_HOOK_ERROR' || errorObj?.code === 'QUERY_ERROR') {
          return {
            message: errorMessage,
            code: 'QUERY_HOOK_ERROR',
            originalError: errorData,
          };
        }
        return {
          message: errorMessage,
          code: 'DATABASE_ERROR',
          originalError: errorData,
        };
      }
      if (status === 500) {
        return {
          message: errorMessage,
          code: 'DATABASE_ERROR',
          originalError: errorData,
        };
      }

      // Default: map to DATABASE_ERROR
      return {
        message: errorMessage,
        code: 'DATABASE_ERROR',
        originalError: errorData,
      };
    }

    return {
      message: String(error),
      code: 'DATABASE_ERROR',
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
