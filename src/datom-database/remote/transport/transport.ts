/**
 * Transport abstraction for remote database communication
 * Completely decoupled from HTTP/SSE/WebSocket implementation details
 */

import { QueryError, QueryTimeoutError } from "../../hook/hook.js";
import type { DatalogQuery } from "../../../datalog/datalog.js";

/**
 * Transport error that can be thrown by transport implementations
 */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "TransportError";
    Object.setPrototypeOf(this, TransportError.prototype);
  }

  /**
   * Convert a TransportError to the appropriate query error type
   * @param query Optional query for QueryTimeoutError
   * @returns The converted error (QueryError or QueryTimeoutError)
   * @throws The converted error
   */
  toQueryError(query?: DatalogQuery): never {
    if (this.code === "QUERY_HOOK_ERROR" || this.code === "QUERY_ERROR") {
      const errorData = this.originalError as {
        errors?: Array<{ hook: string; message: string; code?: string }>;
      };
      if (errorData?.errors) {
        throw new QueryError(this.message, errorData.errors);
      }
      throw new QueryError(this.message, []);
    }
    if (this.code === "QUERY_TIMEOUT") {
      throw new QueryTimeoutError(0, query);
    }
    throw new QueryError(`Query failed: ${this.message}`, []);
  }
}

/**
 * Transport interface for remote database communication
 * Implementations can use HTTP, SSE, WebSocket, or any other protocol
 */
export interface ITransport {
  /**
   * Send a request to the remote server and wait for a response
   * @param method The method name (e.g., "datoms", "query", "transact")
   * @param payload The request payload
   * @returns The response payload
   * @throws TransportError if the request fails
   */
  request<TRequest = unknown, TResponse = unknown>(
    method: string,
    payload: TRequest
  ): Promise<TResponse>;

  /**
   * Close the transport connection and clean up resources
   */
  close(): Promise<void>;
}
