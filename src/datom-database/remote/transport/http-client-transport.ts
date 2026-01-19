/**
 * HTTP client transport implementation
 * Uses HttpClient to communicate with remote database server
 */

import type { HttpClient } from "../../../http-client/http-client.js";
import type {
  ITransport,
  InitializeRequest,
  InitializeResponse,
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
  RegisterHookRequest,
  RegisterHookResponse,
  GetObsoleteDatomsRequest,
  GetObsoleteDatomsResponse,
  DeleteDatomsRequest,
  DeleteDatomsResponse,
} from "./transport.js";
import { TransportError } from "./transport.js";

/**
 * HTTP client transport that uses HttpClient to communicate with remote database
 */
export class HttpClientTransport implements ITransport {
  private initialized = false;

  constructor(
    private readonly httpClient: HttpClient,
    private readonly endpoint: string
  ) {}

  async initialize(): Promise<InitializeResponse> {
    try {
      const request: InitializeRequest = { method: "initialize" };
      const response = await this.httpClient.post<InitializeResponse>(
        this.endpoint,
        request
      );
      this.initialized = true;
      return response;
    } catch (error) {
      throw this._mapError(error, "Failed to initialize remote database");
    }
  }

  async datoms(request: DatomsRequest): Promise<DatomsResponse> {
    try {
      return await this.httpClient.post<DatomsResponse>(this.endpoint, request);
    } catch (error) {
      throw this._mapError(error, "Failed to query datoms");
    }
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    try {
      return await this.httpClient.post<QueryResponse>(this.endpoint, request);
    } catch (error) {
      throw this._mapError(error, "Failed to execute query");
    }
  }

  async transact(request: TransactRequest): Promise<TransactResponse> {
    try {
      return await this.httpClient.post<TransactResponse>(
        this.endpoint,
        request
      );
    } catch (error) {
      throw this._mapError(error, "Failed to execute transaction");
    }
  }

  async getLatestTransaction(): Promise<GetLatestTransactionResponse> {
    try {
      const request: GetLatestTransactionRequest = {
        method: "getLatestTransaction",
      };
      return await this.httpClient.post<GetLatestTransactionResponse>(
        this.endpoint,
        request
      );
    } catch (error) {
      throw this._mapError(error, "Failed to get latest transaction");
    }
  }

  async getTransactionMetadata(
    request: GetTransactionMetadataRequest
  ): Promise<GetTransactionMetadataResponse> {
    try {
      return await this.httpClient.post<GetTransactionMetadataResponse>(
        this.endpoint,
        request
      );
    } catch (error) {
      throw this._mapError(error, "Failed to get transaction metadata");
    }
  }

  async registerHook(
    request: RegisterHookRequest
  ): Promise<RegisterHookResponse> {
    try {
      return await this.httpClient.post<RegisterHookResponse>(
        this.endpoint,
        request
      );
    } catch (error) {
      throw this._mapError(error, "Failed to register hook");
    }
  }

  async getObsoleteDatoms(
    request: GetObsoleteDatomsRequest
  ): Promise<GetObsoleteDatomsResponse> {
    try {
      return await this.httpClient.post<GetObsoleteDatomsResponse>(
        this.endpoint,
        request
      );
    } catch (error) {
      throw this._mapError(error, "Failed to get obsolete datoms");
    }
  }

  async deleteDatoms(
    request: DeleteDatomsRequest
  ): Promise<DeleteDatomsResponse> {
    try {
      return await this.httpClient.post<DeleteDatomsResponse>(
        this.endpoint,
        request
      );
    } catch (error) {
      throw this._mapError(error, "Failed to delete datoms");
    }
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  /**
   * Map HTTP errors to TransportError
   */
  private _mapError(error: unknown, defaultMessage: string): TransportError {
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
      const errorWithResponse = error as unknown as { response?: unknown };
      if (errorWithResponse.response) {
        errorData = errorWithResponse.response;
      }

      // Map HTTP status codes to transport error codes
      if (status === 408) {
        return new TransportError(error.message, "QUERY_TIMEOUT", errorData);
      }
      if (status === 400) {
        // Try to determine specific error type from error data
        const errorObj = errorData as {
          code?: string;
          errors?: Array<{ hook: string; message: string; code?: string }>;
        };
        if (errorObj?.code === "QUERY_SAFETY_VIOLATION") {
          return new TransportError(
            error.message,
            "QUERY_SAFETY_VIOLATION",
            errorData
          );
        }
        if (
          errorObj?.code === "TRANSACTION_HOOK_ERROR" ||
          errorObj?.code === "TRANSACTION_ERROR"
        ) {
          return new TransportError(
            error.message,
            "TRANSACTION_HOOK_ERROR",
            errorData
          );
        }
        if (
          errorObj?.code === "QUERY_HOOK_ERROR" ||
          errorObj?.code === "QUERY_ERROR"
        ) {
          return new TransportError(
            error.message,
            "QUERY_HOOK_ERROR",
            errorData
          );
        }
        return new TransportError(error.message, "DATABASE_ERROR", errorData);
      }
      if (status === 500) {
        return new TransportError(error.message, "DATABASE_ERROR", errorData);
      }

      // Default: map to DATABASE_ERROR
      return new TransportError(
        error.message || defaultMessage,
        "DATABASE_ERROR",
        errorData
      );
    }

    return new TransportError(
      String(error) || defaultMessage,
      "DATABASE_ERROR",
      error
    );
  }
}
