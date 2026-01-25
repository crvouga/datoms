/**
 * HTTP server component for HTTP client transport
 * Handles web standard Request/Response objects
 */

import type {DatomDatabase} from '../datom-database.js';
import {
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionError,
} from '../hook/hook.js';
import {ConfiguredDatomDatabaseView} from '../views/configured-datom-database-view.js';
import type {ViewConfig} from '../views/view-config.js';
import type {
  DeleteDatomsRequest,
  DeleteDatomsResponse,
  GetLatestTransactionRequest,
  GetLatestTransactionResponse,
  InitializeRequest,
  InitializeResponse,
  QueryRequest,
  QueryResponse,
  RegisterHookRequest,
  RegisterHookResponse,
  TransactRequest,
  TransactResponse,
  TransportRequest,
  TransportResponse,
} from './http-client-transport-types.js';

/**
 * Server component that handles HTTP requests for the HTTP client transport
 * Uses web standard Request/Response objects
 */
export class HttpClientDatomDatabaseServerComponent {
  private initialized = false;
  private db: DatomDatabase;

  constructor(db: DatomDatabase) {
    this.db = db;
  }

  /**
   * Update the database reference (useful for test fixtures that need to reset state)
   */
  setDatabase(db: DatomDatabase): void {
    this.db = db;
    this.initialized = false;
  }

  /**
   * Handle an incoming HTTP request
   * @param request Web standard Request object
   * @returns Web standard Response object
   */
  async handleRequest(request: Request): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Only accept POST requests
    if (request.method !== 'POST') {
      return this._errorResponse(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
    }

    // Validate Content-Type
    const contentType = request.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return this._errorResponse(
        400,
        'Content-Type must be application/json',
        'INVALID_CONTENT_TYPE',
      );
    }

    try {
      // Parse request body
      const body = (await request.json()) as unknown;
      const transportRequest = body as TransportRequest;

      // Route based on method
      let response: TransportResponse;
      switch (transportRequest.method) {
        case 'initialize':
          response = await this._handleInitialize(transportRequest as InitializeRequest);
          break;
        case 'query':
          response = await this._handleQuery(transportRequest as QueryRequest);
          break;
        case 'transact':
          response = await this._handleTransact(transportRequest as TransactRequest);
          break;
        case 'getLatestTransaction':
          response = await this._handleGetLatestTransaction(
            transportRequest as GetLatestTransactionRequest,
          );
          break;
        case 'registerHook':
          response = await this._handleRegisterHook(transportRequest as RegisterHookRequest);
          break;
        case 'deleteDatoms':
          response = await this._handleDeleteDatoms(transportRequest as DeleteDatomsRequest);
          break;
        default:
          return this._errorResponse(
            400,
            `Unknown method: ${(transportRequest as {method?: string}).method}`,
            'UNKNOWN_METHOD',
          );
      }

      // Return successful response
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      return this._mapErrorToResponse(error);
    }
  }

  private async _handleInitialize(_request: InitializeRequest): Promise<InitializeResponse> {
    await this.db.initialize();
    this.initialized = true;
    return {success: true};
  }

  private async _handleQuery(request: QueryRequest): Promise<QueryResponse> {
    await this._ensureInitialized();

    const view = this._createView(request.viewConfig);
    // Merge context and viewConfig into query object for DatabaseView interface
    const queryWithContext = {
      ...request.query,
      context: request.context ?? request.query.context,
      viewConfig: request.viewConfig,
    };
    const {data: results} = await view.query(queryWithContext);
    return {results};
  }

  private async _handleTransact(request: TransactRequest): Promise<TransactResponse> {
    await this._ensureInitialized();

    const txId = await this.db.transact(request.ops, request.metadata, request.context);
    return {txId};
  }

  private async _handleGetLatestTransaction(
    _request: GetLatestTransactionRequest,
  ): Promise<GetLatestTransactionResponse> {
    await this._ensureInitialized();

    const transaction = await this.db._getLatestTransaction();
    return {
      // biome-ignore lint/style/noNonNullAssertion: transaction.txId is guaranteed to exist for latest transaction
      txId: transaction.txId!,
      datoms: transaction.datoms,
      meta: transaction.meta,
    };
  }

  private async _handleRegisterHook(request: RegisterHookRequest): Promise<RegisterHookResponse> {
    await this._ensureInitialized();

    this.db.hook(request.hook);
    return {success: true};
  }

  private async _handleDeleteDatoms(request: DeleteDatomsRequest): Promise<DeleteDatomsResponse> {
    await this._ensureInitialized();

    const deleted = await this.db._destroy(request.config);
    return {success: true, deleted};
  }

  private _createView(viewConfig: ViewConfig) {
    return new ConfiguredDatomDatabaseView(this.db, viewConfig);
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.db.initialize();
      this.initialized = true;
    }
  }

  /**
   * Map database errors to HTTP error responses
   */
  private _mapErrorToResponse(error: unknown): Response {
    if (error instanceof QueryTimeoutError) {
      return this._errorResponse(408, error.message, 'QUERY_TIMEOUT');
    }
    if (error instanceof QuerySafetyError) {
      return this._errorResponse(400, error.message, 'QUERY_SAFETY_VIOLATION');
    }
    if (error instanceof QueryResultSizeError) {
      return this._errorResponse(400, error.message, 'QUERY_RESULT_SIZE_EXCEEDED', undefined, {
        resultSize: error.resultSize,
        maxResultSize: error.maxResultSize,
        queryOptions: error.queryOptions,
      });
    }
    if (error instanceof TransactionError) {
      return this._errorResponse(400, error.message, 'TRANSACTION_HOOK_ERROR', error.errors || []);
    }
    if (error instanceof QueryError) {
      return this._errorResponse(400, error.message, 'QUERY_HOOK_ERROR', error.errors || []);
    }
    if (error instanceof Error) {
      return this._errorResponse(500, error.message, 'DATABASE_ERROR');
    }
    return this._errorResponse(500, String(error), 'DATABASE_ERROR');
  }

  /**
   * Create an error response
   */
  private _errorResponse(
    status: number,
    message: string,
    code: string,
    errors?: Array<{hook: string; message: string; code?: string}>,
    extraData?: Record<string, unknown>,
  ): Response {
    const errorBody: {
      error: string;
      code: string;
      errors?: Array<{hook: string; message: string; code?: string}>;
      [key: string]: unknown;
    } = {
      error: message,
      code,
    };

    if (errors && errors.length > 0) {
      errorBody.errors = errors;
    }

    if (extraData) {
      Object.assign(errorBody, extraData);
    }

    return new Response(JSON.stringify(errorBody), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
