/**
 * Hook engine for managing and executing database hooks
 * Supports before-read, after-read, before-write, and after-write hooks
 */

import type { DatalogQuery } from "../../datalog/datalog.js";
import type { Datom, TransactionId } from "../../datoms.js";
import type { Transaction } from "../../types.js";
import type { DatabaseView } from "../views/database-view.js";

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
 * Context passed to read hooks
 * Contains database reference and any additional context data
 * Note: This is a generic type that gets resolved when used with DatomDatabase
 */
export type ReadContext = {
  db: DatabaseView;
  [key: string]: unknown;
};

/**
 * Context passed to write hooks
 * Contains database reference, transaction metadata, and any additional context data
 * Note: This is a generic type that gets resolved when used with DatomDatabase
 */
export type WriteContext = {
  db: DatabaseView;
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
  type: "beforeRead";
  name: string;
  execute: (query: DatalogQuery, ctx: ReadContext) => Promise<BeforeReadResult>;
};

/**
 * Result from after-read hooks
 */
export type AfterReadResult = {
  datoms: Datom[];
  errors?: HookError[];
  stopProcessing?: boolean;
};

/**
 * After-read hook
 * Runs after query execution, can filter/transform results or return errors
 */
export type AfterRead = {
  type: "afterRead";
  name: string;
  execute: (datoms: Datom[], ctx: ReadContext) => Promise<AfterReadResult>;
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
  type: "beforeWrite";
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
  type: "afterWrite";
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
    public readonly code?: string
  ) {
    super(message);
    this.name = "DatomDatabaseError";
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
    public readonly conflictingTxId?: number
  ) {
    super(message, "TRANSACTION_CONFLICT");
    this.name = "TransactionConflictError";
    Object.setPrototypeOf(this, TransactionConflictError.prototype);
  }
}

/**
 * Error thrown when a query would perform a full table scan without filters
 * @example
 * try {
 *   await db.datoms({}); // Throws QuerySafetyError
 * } catch (error) {
 *   if (error instanceof QuerySafetyError) {
 *     // Add filters or limit to the query
 *   }
 * }
 */
export class QuerySafetyError extends DatomDatabaseError {
  constructor(message: string) {
    super(message, "QUERY_SAFETY_VIOLATION");
    this.name = "QuerySafetyError";
    Object.setPrototypeOf(this, QuerySafetyError.prototype);
  }
}

/**
 * Error thrown when a query exceeds its timeout
 * @example
 * try {
 *   await db.datoms({ entity: 1, timeoutMs: 100 });
 * } catch (error) {
 *   if (error instanceof QueryTimeoutError) {
 *     // Query took too long
 *   }
 * }
 */
export class QueryTimeoutError extends DatomDatabaseError {
  constructor(
    public readonly timeoutMs: number,
    public readonly queryOptions?: unknown
  ) {
    super(`Query exceeded timeout of ${timeoutMs}ms`, "QUERY_TIMEOUT");
    this.name = "QueryTimeoutError";
    Object.setPrototypeOf(this, QueryTimeoutError.prototype);
  }
}

/**
 * Error thrown when a query result exceeds the maximum allowed size
 * @example
 * try {
 *   await db.datoms({ attribute: "tag", maxResultSize: 1000 });
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
    public readonly queryOptions?: unknown
  ) {
    super(
      `Query result size ${resultSize} exceeds maximum allowed size ${maxResultSize}`,
      "QUERY_RESULT_SIZE_EXCEEDED"
    );
    this.name = "QueryResultSizeError";
    Object.setPrototypeOf(this, QueryResultSizeError.prototype);
  }
}

/**
 * Error thrown when connection pool is exhausted
 * @example
 * try {
 *   await db.datoms({ entity: 1 });
 * } catch (error) {
 *   if (error instanceof ConnectionPoolExhaustedError) {
 *     // No connections available
 *   }
 * }
 */
export class ConnectionPoolExhaustedError extends DatomDatabaseError {
  constructor(
    public readonly waitingRequests: number,
    public readonly maxConnections: number
  ) {
    super(
      `Connection pool exhausted: ${waitingRequests} requests waiting, max connections: ${maxConnections}`,
      "CONNECTION_POOL_EXHAUSTED"
    );
    this.name = "ConnectionPoolExhaustedError";
    Object.setPrototypeOf(this, ConnectionPoolExhaustedError.prototype);
  }
}

/**
 * Error thrown when a query is blocked or fails validation by hooks
 * @example
 * try {
 *   await db.query(query, context);
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
    public readonly errors: HookErrorWithName[]
  ) {
    super(message, "QUERY_HOOK_ERROR");
    this.name = "QueryError";
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
    public readonly errors: HookErrorWithName[]
  ) {
    super(message, "TRANSACTION_HOOK_ERROR");
    this.name = "TransactionError";
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
      case "beforeRead":
        this.beforeRead.push(hook);
        break;
      case "afterRead":
        this.afterRead.push(hook);
        break;
      case "beforeWrite":
        this.beforeWrite.push(hook);
        break;
      case "afterWrite":
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
    ctx: ReadContext
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

    return { query: nextQuery, errors: allErrors };
  }

  /**
   * Run after-read hooks (filter/transform results after execution)
   * @param datoms The datoms returned from the query
   * @param ctx Read context with database reference and additional data
   * @returns Filtered/transformed datoms and any errors
   */
  async runAfterRead(
    datoms: Datom[],
    ctx: ReadContext
  ): Promise<{
    datoms: Datom[];
    errors: HookErrorWithName[];
  }> {
    let result = datoms;
    const allErrors: HookErrorWithName[] = [];

    for (const hook of this.afterRead) {
      const hookResult = await hook.execute(result, ctx);

      result = hookResult.datoms;

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

    return { datoms: result, errors: allErrors };
  }

  /**
   * Run before-write hooks (validate/augment before commit)
   * @param tx The transaction to process
   * @param ctx Write context with database reference, metadata, and additional data
   * @returns Modified transaction and any errors
   */
  async runBeforeWrite(
    tx: Transaction,
    ctx: WriteContext
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

    return { tx: result, errors: allErrors };
  }

  /**
   * Run after-write hooks (side effects after commit)
   * Failures in after-write hooks don't fail the transaction
   * @param result The write result containing transaction ID, datoms, and timestamp
   * @param ctx Write context with database reference, metadata, and additional data
   */
  async runAfterWrite(result: WriteResult, ctx: WriteContext): Promise<void> {
    await Promise.allSettled(
      this.afterWrite.map((hook) =>
        hook.execute(result, ctx).catch((err) => {
          console.error(`After-write hook "${hook.name}" failed:`, err);
        })
      )
    );
  }
}
