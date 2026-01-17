/**
 * Interceptor engine for managing and executing database interceptors
 * Supports before-read, after-read, before-write, and after-write interceptors
 */

import type { DatalogQuery } from "../../datalog/datalog.js";
import type { Datom, Transaction } from "../../types.js";
import { DatabaseView } from "../datom-database-types.js";

/**
 * Error structure returned by interceptors
 */
export type InterceptorError = {
  message: string;
  code?: string;
  datom?: Datom;
};
/**
 * Error with interceptor name attached
 */
export type InterceptorErrorWithName = {
  interceptor: string;
} & InterceptorError;

/**
 * Context passed to read interceptors
 * Contains database reference and any additional context data
 * Note: This is a generic type that gets resolved when used with DatomDatabase
 */
export type ReadContext = {
  db: DatabaseView;
  [key: string]: unknown;
};

/**
 * Context passed to write interceptors
 * Contains database reference, transaction metadata, and any additional context data
 * Note: This is a generic type that gets resolved when used with DatomDatabase
 */
export type WriteContext = {
  db: DatabaseView;
  txMeta?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Result from before-read interceptors
 */
export type BeforeReadResult = {
  query: DatalogQuery;
  errors?: InterceptorError[];
  stopProcessing?: boolean;
};

/**
 * Before-read interceptor
 * Runs before query execution, can modify query or return errors
 */
export type BeforeRead = {
  type: "beforeRead";
  name: string;
  execute: (query: DatalogQuery, ctx: ReadContext) => Promise<BeforeReadResult>;
};

/**
 * After-read interceptor
 * Runs after query execution, can filter/transform results
 */
export type AfterRead = {
  type: "afterRead";
  name: string;
  execute: (datoms: Datom[], ctx: ReadContext) => Promise<Datom[]>;
};

/**
 * Result from before-write interceptors
 */
export type BeforeWriteResult = {
  tx: Transaction;
  errors?: InterceptorError[];
  stopProcessing?: boolean;
};

/**
 * Before-write interceptor
 * Runs before transaction commit, can validate/augment transaction or return errors
 */
export type BeforeWrite = {
  type: "beforeWrite";
  name: string;
  execute: (tx: Transaction, ctx: WriteContext) => Promise<BeforeWriteResult>;
};

/**
 * After-write interceptor
 * Runs after transaction commit, for side effects (failures don't fail transaction)
 */
export type AfterWrite = {
  type: "afterWrite";
  name: string;
  execute: (tx: Transaction, ctx: WriteContext) => Promise<void>;
};

/**
 * Union type for all interceptor types
 */
export type Interceptor = BeforeRead | AfterRead | BeforeWrite | AfterWrite;

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
 * @example
 * try {
 *   await db.transaction(async (tx) => {
 *     // Long-running transaction that conflicts with another
 *   });
 * } catch (error) {
 *   if (error instanceof TransactionConflictError) {
 *     // Retry the transaction
 *   }
 * }
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
 * Error thrown when a query is blocked or fails validation by interceptors
 * @example
 * try {
 *   await db.query(query, context);
 * } catch (error) {
 *   if (error instanceof QueryError) {
 *     // Handle interceptor errors
 *     console.log("Validation errors:", error.errors);
 *   }
 * }
 */
export class QueryError extends DatomDatabaseError {
  constructor(
    message: string,
    public readonly errors: InterceptorErrorWithName[]
  ) {
    super(message, "QUERY_INTERCEPTOR_ERROR");
    this.name = "QueryError";
    Object.setPrototypeOf(this, QueryError.prototype);
  }
}

/**
 * Error thrown when a transaction fails validation by interceptors
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
    public readonly errors: InterceptorErrorWithName[]
  ) {
    super(message, "TRANSACTION_INTERCEPTOR_ERROR");
    this.name = "TransactionError";
    Object.setPrototypeOf(this, TransactionError.prototype);
  }
}

/**
 * Engine for managing and executing database interceptors
 * Interceptors run in registration order and can modify queries, validate transactions,
 * filter results, or perform side effects
 */
export class InterceptorEngine {
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
   * Register an interceptor
   * @param interceptor The interceptor to register
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
  register(interceptor: Interceptor): void {
    switch (interceptor.type) {
      case "beforeRead":
        this.beforeRead.push(interceptor);
        break;
      case "afterRead":
        this.afterRead.push(interceptor);
        break;
      case "beforeWrite":
        this.beforeWrite.push(interceptor);
        break;
      case "afterWrite":
      default:
        this.afterWrite.push(interceptor);
        break;
    }
  }

  /**
   * Run before-read interceptors (modify/block query before execution)
   * @param query The datalog query to process
   * @param ctx Read context with database reference and additional data
   * @returns Modified query and any errors
   */
  async runBeforeRead(
    query: DatalogQuery,
    ctx: ReadContext
  ): Promise<{
    query: DatalogQuery;
    errors: InterceptorErrorWithName[];
  }> {
    let result = query;
    const allErrors: InterceptorErrorWithName[] = [];

    for (const interceptor of this.beforeRead) {
      const interceptorResult = await interceptor.execute(result, ctx);

      result = interceptorResult.query as DatalogQuery;

      if (interceptorResult.errors && interceptorResult.errors.length > 0) {
        for (const e of interceptorResult.errors) {
          allErrors.push({
            interceptor: interceptor.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (interceptorResult.stopProcessing === true) {
        break;
      }
    }

    return { query: result, errors: allErrors };
  }

  /**
   * Run after-read interceptors (filter/transform results after execution)
   * @param datoms The datoms returned from the query
   * @param ctx Read context with database reference and additional data
   * @returns Filtered/transformed datoms
   */
  async runAfterRead(datoms: Datom[], ctx: ReadContext): Promise<Datom[]> {
    let result = datoms;

    for (const interceptor of this.afterRead) {
      result = await interceptor.execute(result, ctx);
    }

    return result;
  }

  /**
   * Run before-write interceptors (validate/augment before commit)
   * @param tx The transaction to process
   * @param ctx Write context with database reference, metadata, and additional data
   * @returns Modified transaction and any errors
   */
  async runBeforeWrite(
    tx: Transaction,
    ctx: WriteContext
  ): Promise<{
    tx: Transaction;
    errors: InterceptorErrorWithName[];
  }> {
    let result = tx;
    const allErrors: InterceptorErrorWithName[] = [];

    for (const interceptor of this.beforeWrite) {
      const interceptorResult = await interceptor.execute(result, ctx);

      result = interceptorResult.tx;

      if (interceptorResult.errors && interceptorResult.errors.length > 0) {
        for (const e of interceptorResult.errors) {
          allErrors.push({
            interceptor: interceptor.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (interceptorResult.stopProcessing === true) {
        break;
      }
    }

    return { tx: result, errors: allErrors };
  }

  /**
   * Run after-write interceptors (side effects after commit)
   * Failures in after-write interceptors don't fail the transaction
   * @param tx The committed transaction
   * @param ctx Write context with database reference, metadata, and additional data
   */
  async runAfterWrite(tx: Transaction, ctx: WriteContext): Promise<void> {
    await Promise.allSettled(
      this.afterWrite.map((interceptor) =>
        interceptor.execute(tx, ctx).catch((err) => {
          console.error(
            `After-write interceptor "${interceptor.name}" failed:`,
            err
          );
        })
      )
    );
  }
}
