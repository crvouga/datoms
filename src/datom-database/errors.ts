/**
 * Custom error classes for datom database operations
 * These provide more specific error handling than generic Error objects
 */

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
