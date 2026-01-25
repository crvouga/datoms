/**
 * Hook engine for managing and executing database hooks
 * Supports before-read, after-read, before-write, and after-write hooks
 */

import type {DatalogQuery, DatalogQueryFindVariable} from '../../datalog-query.js';
import type {Datom, TransactionId} from '../../datoms.js';
import type {Transaction} from '../../types.js';
import type {DatomDatabaseView, QueryResult} from '../datom-database-view.js';

export type Hook_ =
  | {
      type: 'beforeTransact';
    }
  | {
      type: 'afterTransact';
    }
  | {
      type: 'beforeQuery';
    }
  | {
      type: 'afterQuery';
    };

/**
 * Error structure returned by hooks
 */
export type HookError = {
  message: string;
  code?: string;
  datom?: Datom;
};
/**
 * Error with hook name attached
 */
export type HookErrorWithName = {
  hook: string;
} & HookError;

/**
 * Context passed to read hooks for datalog queries
 * Contains database reference and any additional context data
 * Note: This is a generic type that gets resolved when used with DatomDatabase
 */
export type ReadContext = {
  db: DatomDatabaseView;
  query: DatalogQuery;
  [key: string]: unknown;
};

/**
 * Context passed to write hooks
 * Contains database reference, transaction metadata, and any additional context data
 * Note: This is a generic type that gets resolved when used with DatomDatabase
 */
export type WriteContext = {
  db: DatomDatabaseView;
  txMeta?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Result from before-read hooks
 */
export type BeforeReadResult = {
  query?: DatalogQuery;
  errors?: HookError[];
  stopProcessing?: boolean;
};

/**
 * Before-read hook
 * Runs before query execution, can modify query or return errors
 */
export type BeforeRead = {
  type: 'beforeRead';
  name: string;
  execute: (query: DatalogQuery, ctx: ReadContext) => Promise<BeforeReadResult>;
};

/**
 * Result from after-read hooks for datalog queries
 */
export type AfterReadResult<
  TFind extends Record<string, DatalogQueryFindVariable> = Record<string, DatalogQueryFindVariable>,
> = {
  results: QueryResult<TFind>;
  errors?: HookError[];
  stopProcessing?: boolean;
};

/**
 * After-read hook for datalog queries
 * Runs after query execution, can filter/transform results or return errors
 */
export type AfterRead<
  TFind extends Record<string, DatalogQueryFindVariable> = Record<string, DatalogQueryFindVariable>,
> = {
  type: 'afterRead';
  name: string;
  execute: (results: QueryResult<TFind>, ctx: ReadContext) => Promise<AfterReadResult<TFind>>;
};

/**
 * Result from before-write hooks
 */
export type BeforeWriteResult = {
  tx: Transaction;
  errors?: HookError[];
  stopProcessing?: boolean;
};

/**
 * Before-write hook
 * Runs before transaction commit, can validate/augment transaction or return errors
 */
export type BeforeWrite = {
  type: 'beforeWrite';
  name: string;
  execute: (tx: Transaction, ctx: WriteContext) => Promise<BeforeWriteResult>;
};

/**
 * Result of a successful write operation
 * Contains the transaction ID, final datoms written, and timestamp
 */
export type WriteResult = {
  txId: TransactionId;
  datoms: Datom[];
  timestamp: number;
};

/**
 * After-write hook
 * Runs after transaction commit, for side effects (failures don't fail transaction)
 * Receives WriteResult containing transaction ID and final datoms written
 */
export type AfterWrite = {
  type: 'afterWrite';
  name: string;
  execute: (result: WriteResult, ctx: WriteContext) => Promise<void>;
};

/**
 * Union type for all hook types
 */
export type Hook = BeforeRead | AfterRead | BeforeWrite | AfterWrite;

/**
 * Base error class for all datom database errors
 */
export class DatomDatabaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DatomDatabaseError';
    Object.setPrototypeOf(this, DatomDatabaseError.prototype);
  }
}

/**
 * Error thrown when a transaction conflict occurs
 * Useful for optimistic locking scenarios
 */
export class TransactionConflictError extends DatomDatabaseError {
  constructor(
    message: string,
    public readonly txId?: number,
    public readonly conflictingTxId?: number,
  ) {
    super(message, 'TRANSACTION_CONFLICT');
    this.name = 'TransactionConflictError';
    Object.setPrototypeOf(this, TransactionConflictError.prototype);
  }
}

/**
 * Error thrown when a query would perform a full table scan without filters
 * @example
 * try {
 *   await db.query({ find: { e: ["?e"] }, where: [] }); // Throws QuerySafetyError
 * } catch (error) {
 *   if (error instanceof QuerySafetyError) {
 *     // Add filters or limit to the query
 *   }
 * }
 */
export class QuerySafetyError extends DatomDatabaseError {
  constructor(message: string) {
    super(message, 'QUERY_SAFETY_VIOLATION');
    this.name = 'QuerySafetyError';
    Object.setPrototypeOf(this, QuerySafetyError.prototype);
  }
}

/**
 * Error thrown when a query exceeds its timeout
 * @example
 * try {
 *   const { data } = await db.query({
 *     find: { e: ["?e"], a: ["?a"], v: ["?v"] },
 *     where: [{ e: 1, a: "?a", v: "?v" }],
 *     timeoutMs: 100
 *   });
 * } catch (error) {
 *   if (error instanceof QueryTimeoutError) {
 *     // Query took too long
 *   }
 * }
 */
export class QueryTimeoutError extends DatomDatabaseError {
  constructor(
    public readonly timeoutMs: number,
    public readonly queryOptions?: unknown,
  ) {
    super(`Query exceeded timeout of ${timeoutMs}ms`, 'QUERY_TIMEOUT');
    this.name = 'QueryTimeoutError';
    Object.setPrototypeOf(this, QueryTimeoutError.prototype);
  }
}

/**
 * Error thrown when a query result exceeds the maximum allowed size
 * @example
 * try {
 *   const { data } = await db.query({
 *     find: { e: ["?e"], a: ["?a"], v: ["?v"] },
 *     where: [{ e: "?e", a: "tag", v: "?v" }],
 *     maxResultSize: 1000
 *   });
 * } catch (error) {
 *   if (error instanceof QueryResultSizeError) {
 *     // Result set too large
 *   }
 * }
 */
export class QueryResultSizeError extends DatomDatabaseError {
  constructor(
    public readonly resultSize: number,
    public readonly maxResultSize: number,
    public readonly queryOptions?: unknown,
  ) {
    super(
      `Query result size ${resultSize} exceeds maximum allowed size ${maxResultSize}`,
      'QUERY_RESULT_SIZE_EXCEEDED',
    );
    this.name = 'QueryResultSizeError';
    Object.setPrototypeOf(this, QueryResultSizeError.prototype);
  }
}

/**
 * Error thrown when connection pool is exhausted
 * @example
 * try {
 *   const { data } = await db.query({
 *     find: { e: ["?e"], a: ["?a"], v: ["?v"] },
 *     where: [{ e: 1, a: "?a", v: "?v" }]
 *   });
 * } catch (error) {
 *   if (error instanceof ConnectionPoolExhaustedError) {
 *     // No connections available
 *   }
 * }
 */
export class ConnectionPoolExhaustedError extends DatomDatabaseError {
  constructor(
    public readonly waitingRequests: number,
    public readonly maxConnections: number,
  ) {
    super(
      `Connection pool exhausted: ${waitingRequests} requests waiting, max connections: ${maxConnections}`,
      'CONNECTION_POOL_EXHAUSTED',
    );
    this.name = 'ConnectionPoolExhaustedError';
    Object.setPrototypeOf(this, ConnectionPoolExhaustedError.prototype);
  }
}

/**
 * Error thrown when a query is blocked or fails validation by hooks
 * @example
 * try {
 *   const { data } = await db.query(query);
 * } catch (error) {
 *   if (error instanceof QueryError) {
 *     // Handle hook errors
 *     console.log("Validation errors:", error.errors);
 *   }
 * }
 */
export class QueryError extends DatomDatabaseError {
  constructor(
    message: string,
    public readonly errors: HookErrorWithName[],
  ) {
    super(message, 'QUERY_HOOK_ERROR');
    this.name = 'QueryError';
    Object.setPrototypeOf(this, QueryError.prototype);
  }
}

/**
 * Error thrown when a transaction fails validation by hooks
 * @example
 * try {
 *   await db.transact(ops, metadata, context);
 * } catch (error) {
 *   if (error instanceof TransactionError) {
 *     // Handle validation errors
 *     console.log("Validation errors:", error.errors);
 *   }
 * }
 */
export class TransactionError extends DatomDatabaseError {
  constructor(
    message: string,
    public readonly errors: HookErrorWithName[],
  ) {
    super(message, 'TRANSACTION_HOOK_ERROR');
    this.name = 'TransactionError';
    Object.setPrototypeOf(this, TransactionError.prototype);
  }
}

/**
 * Engine for managing and executing database hooks
 * Hooks run in registration order and can modify queries, validate transactions,
 * filter results, or perform side effects
 */
export class HookEngine {
  private beforeRead: BeforeRead[];
  private afterRead: AfterRead[];
  private beforeWrite: BeforeWrite[];
  private afterWrite: AfterWrite[];

  constructor() {
    this.beforeRead = [];
    this.afterRead = [];
    this.beforeWrite = [];
    this.afterWrite = [];
  }

  /**
   * Register a hook
   * @param hook The hook to register
   * @example
   * engine.register({
   *   type: "beforeWrite",
   *   name: "validate-email",
   *   execute: async (tx, ctx) => {
   *     // Validation logic
   *     return { tx, errors: undefined };
   *   }
   * });
   */
  register(hook: Hook): void {
    switch (hook.type) {
      case 'beforeRead':
        this.beforeRead.push(hook);
        break;
      case 'afterRead':
        this.afterRead.push(hook);
        break;
      case 'beforeWrite':
        this.beforeWrite.push(hook);
        break;
      default:
        this.afterWrite.push(hook);
        break;
    }
  }

  /**
   * Run before-read hooks (modify/block query before execution)
   * @param query The datalog query to process
   * @param ctx Read context with database reference and additional data
   * @returns Modified query and any errors
   */
  async runBeforeRead(
    query: DatalogQuery,
    ctx: ReadContext,
  ): Promise<{
    query: DatalogQuery;
    errors: HookErrorWithName[];
  }> {
    let nextQuery = query;
    const allErrors: HookErrorWithName[] = [];

    for (const hook of this.beforeRead) {
      const hookResult = await hook.execute(nextQuery, ctx);

      nextQuery = hookResult.query ?? nextQuery ?? query;

      if (hookResult.errors && hookResult.errors.length > 0) {
        for (const e of hookResult.errors) {
          allErrors.push({
            hook: hook.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (hookResult.stopProcessing) {
        break;
      }
    }

    return {query: nextQuery, errors: allErrors};
  }

  /**
   * Run after-read hooks for datalog queries (filter/transform results after execution)
   * @param results The query results returned from the query
   * @param ctx Read context with database reference and additional data
   * @returns Filtered/transformed results and any errors
   */
  async runAfterRead<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    results: QueryResult<TFind>,
    ctx: ReadContext,
  ): Promise<{
    results: QueryResult<TFind>;
    errors: HookErrorWithName[];
  }> {
    let result: QueryResult<TFind> = results;
    const allErrors: HookErrorWithName[] = [];

    for (const hook of this.afterRead) {
      // Type assertion needed because hooks can have different TFind types
      // but at runtime they all work with QueryResult
      const hookResult = await (hook as AfterRead<TFind>).execute(
        result as QueryResult<TFind>,
        ctx,
      );

      result = hookResult.results as QueryResult<TFind>;

      if (hookResult.errors && hookResult.errors.length > 0) {
        for (const e of hookResult.errors) {
          allErrors.push({
            hook: hook.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (hookResult.stopProcessing) {
        break;
      }
    }

    return {results: result, errors: allErrors};
  }

  /**
   * Run before-write hooks (validate/augment before commit)
   * @param tx The transaction to process
   * @param ctx Write context with database reference, metadata, and additional data
   * @returns Modified transaction and any errors
   */
  async runBeforeWrite(
    tx: Transaction,
    ctx: WriteContext,
  ): Promise<{
    tx: Transaction;
    errors: HookErrorWithName[];
  }> {
    let result = tx;
    const allErrors: HookErrorWithName[] = [];

    for (const hook of this.beforeWrite) {
      const hookResult = await hook.execute(result, ctx);

      result = hookResult.tx;

      if (hookResult.errors && hookResult.errors.length > 0) {
        for (const e of hookResult.errors) {
          allErrors.push({
            hook: hook.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (hookResult.stopProcessing) {
        break;
      }
    }

    return {tx: result, errors: allErrors};
  }

  /**
   * Run after-write hooks (side effects after commit)
   * Failures in after-write hooks don't fail the transaction
   * @param result The write result containing transaction ID, datoms, and timestamp
   * @param ctx Write context with database reference, metadata, and additional data
   */
  async runAfterWrite(result: WriteResult, ctx: WriteContext): Promise<void> {
    await Promise.allSettled(
      this.afterWrite.map(hook =>
        hook.execute(result, ctx).catch(err => {
          console.error(`After-write hook "${hook.name}" failed:`, err);
        }),
      ),
    );
  }
}
