/**
 * Transport abstraction for remote database communication
 * Completely decoupled from HTTP/SSE/WebSocket implementation details
 */

import { QueryError, QueryTimeoutError } from "../../hook/hook.js";
import type { DatalogQuery } from "../../../datalog/datalog.js";
import type {
  DatomsRequest,
  DatomsResponse,
  QueryRequest,
  QueryResponse,
  TransactRequest,
  TransactResponse,
  GetLatestTransactionResponse,
  GetTransactionMetadataRequest,
  GetTransactionMetadataResponse,
  RegisterHookRequest,
  RegisterHookResponse,
  GetObsoleteDatomsRequest,
  GetObsoleteDatomsResponse,
  DeleteDatomsRequest,
  DeleteDatomsResponse,
  InitializeResponse,
} from "./types.js";

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
   * Initialize the remote database connection
   * @returns The initialization response
   * @throws TransportError if initialization fails
   */
  initialize(): Promise<InitializeResponse>;

  /**
   * Query datoms from the remote database
   * @param request The datoms query request
   * @returns The datoms query response
   * @throws TransportError if the request fails
   */
  datoms(request: DatomsRequest): Promise<DatomsResponse>;

  /**
   * Execute a datalog query on the remote database
   * @param request The query request
   * @returns The query response
   * @throws TransportError if the request fails
   */
  query(request: QueryRequest): Promise<QueryResponse>;

  /**
   * Execute a transaction on the remote database
   * @param request The transaction request
   * @returns The transaction response
   * @throws TransportError if the request fails
   */
  transact(request: TransactRequest): Promise<TransactResponse>;

  /**
   * Get the latest transaction ID from the remote database
   * @returns The latest transaction response
   * @throws TransportError if the request fails
   */
  getLatestTransaction(): Promise<GetLatestTransactionResponse>;

  /**
   * Get transaction metadata from the remote database
   * @param request The transaction metadata request
   * @returns The transaction metadata response
   * @throws TransportError if the request fails
   */
  getTransactionMetadata(
    request: GetTransactionMetadataRequest
  ): Promise<GetTransactionMetadataResponse>;

  /**
   * Register a hook on the remote database
   * @param request The hook registration request
   * @returns The hook registration response
   * @throws TransportError if the request fails
   */
  registerHook(request: RegisterHookRequest): Promise<RegisterHookResponse>;

  /**
   * Get obsolete datoms from the remote database
   * @param request The obsolete datoms request
   * @returns The obsolete datoms response
   * @throws TransportError if the request fails
   */
  getObsoleteDatoms(
    request: GetObsoleteDatomsRequest
  ): Promise<GetObsoleteDatomsResponse>;

  /**
   * Delete datoms from the remote database
   * @param request The delete datoms request
   * @returns The delete datoms response
   * @throws TransportError if the request fails
   */
  deleteDatoms(request: DeleteDatomsRequest): Promise<DeleteDatomsResponse>;

  /**
   * Close the transport connection and clean up resources
   */
  close(): Promise<void>;
}
