/**
 * Shared types for HTTP client transport contract
 * Defines the request/response types used for communication between
 * HttpClientDatomDatabase (client) and HttpClientDatomDatabaseServerComponent (server)
 */

import type {DatalogQuery} from '../../datalog-query.js';
import type {Datom, DatomInput, TransactionId} from '../../datoms.js';
import type {Hook} from '../hook/hook.js';
import type {QueryResult} from '../views/database-view.js';
import type {ViewConfig} from '../views/view-config.js';

// Request types
export interface InitializeRequest {
  method: 'initialize';
}

export interface QueryRequest {
  method: 'query';
  query: DatalogQuery;
  context?: Record<string, unknown>;
  viewConfig: ViewConfig;
}

export interface TransactRequest {
  method: 'transact';
  ops: (DatomInput | DatomInput[])[];
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface GetLatestTransactionRequest {
  method: 'getLatestTransaction';
}

export interface RegisterHookRequest {
  method: 'registerHook';
  hook: Hook;
}

export interface DeleteDatomsRequest {
  method: 'deleteDatoms';
  config: {retentionCount: number};
}

// Response types
export interface InitializeResponse {
  success: boolean;
}

export interface QueryResponse {
  results: QueryResult;
}

export interface TransactResponse {
  txId: TransactionId;
}

export interface GetLatestTransactionResponse {
  txId: TransactionId;
  datoms: Datom[];
  meta?: Record<string, unknown>;
}

export interface RegisterHookResponse {
  success: boolean;
}

export interface DeleteDatomsResponse {
  success: boolean;
  deleted?: number;
}

// Union types for request/response routing
export type TransportRequest =
  | InitializeRequest
  | QueryRequest
  | TransactRequest
  | GetLatestTransactionRequest
  | RegisterHookRequest
  | DeleteDatomsRequest;

export type TransportResponse =
  | InitializeResponse
  | QueryResponse
  | TransactResponse
  | GetLatestTransactionResponse
  | RegisterHookResponse
  | DeleteDatomsResponse;
