/**
 * Request and response types for remote database communication
 */

import type { DatalogQuery, QueryResult } from "../../../datalog/datalog.js";
import type { Datom, DatomInput, TransactionId } from "../../../datoms.js";
import type { ViewConfig } from "../../views/internal-database-view.js";
import type { DatomsParams } from "../../views/database-view.js";
import type { Hook } from "../../hook/hook.js";

/**
 * Initialize request
 */
export interface InitializeRequest {
  method: "initialize";
}

/**
 * Initialize response
 */
export interface InitializeResponse {
  success: boolean;
}

/**
 * Datoms query request
 */
export interface DatomsRequest {
  method: "datoms";
  options: DatomsParams;
  viewConfig: ViewConfig;
}

/**
 * Datoms query response
 */
export interface DatomsResponse {
  datoms: Datom[];
}

/**
 * Datalog query request
 */
export interface QueryRequest {
  method: "query";
  query: DatalogQuery;
  context?: Record<string, unknown>;
  viewConfig: ViewConfig;
}

/**
 * Datalog query response
 */
export interface QueryResponse {
  results: QueryResult;
}

/**
 * Transaction request
 */
export interface TransactRequest {
  method: "transact";
  ops: (DatomInput | DatomInput[])[];
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/**
 * Transaction response
 */
export interface TransactResponse {
  txId: TransactionId;
}

/**
 * Get latest transaction request
 */
export interface GetLatestTransactionRequest {
  method: "getLatestTransaction";
}

/**
 * Get latest transaction response
 */
export interface GetLatestTransactionResponse {
  txId: TransactionId;
}

/**
 * Get transaction metadata request
 */
export interface GetTransactionMetadataRequest {
  method: "getTransactionMetadata";
  txId: TransactionId;
}

/**
 * Get transaction metadata response
 */
export interface GetTransactionMetadataResponse {
  metadata?: Record<string, unknown>;
}

/**
 * Register hook request
 */
export interface RegisterHookRequest {
  method: "registerHook";
  hook: Hook;
}

/**
 * Register hook response
 */
export interface RegisterHookResponse {
  success: boolean;
}

/**
 * Union type for all requests
 */
export type RemoteRequest =
  | InitializeRequest
  | DatomsRequest
  | QueryRequest
  | TransactRequest
  | GetLatestTransactionRequest
  | GetTransactionMetadataRequest
  | RegisterHookRequest;

/**
 * Union type for all responses
 */
export type RemoteResponse =
  | InitializeResponse
  | DatomsResponse
  | QueryResponse
  | TransactResponse
  | GetLatestTransactionResponse
  | GetTransactionMetadataResponse
  | RegisterHookResponse;
