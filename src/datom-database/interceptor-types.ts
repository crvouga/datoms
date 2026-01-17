/**
 * Interceptor types for the datom database
 * These types are separated to avoid circular dependencies with DatomDatabase
 */

import type { DatalogQuery } from "../datalog/datalog.js";
import type { Datom, InterceptorError, Transaction } from "../types.js";

/**
 * Context passed to read interceptors
 * Contains database reference and any additional context data
 * Note: db type uses a forward reference to avoid circular dependency
 * The actual type is resolved when these types are used with DatomDatabase
 */
export type ReadContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any; // DatomDatabase - using any to break circular dependency, resolved at usage site
  [key: string]: unknown;
};

/**
 * Context passed to write interceptors
 * Contains database reference, transaction metadata, and any additional context data
 * Note: db type uses a forward reference to avoid circular dependency
 * The actual type is resolved when these types are used with DatomDatabase
 */
export type WriteContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any; // DatomDatabase - using any to break circular dependency, resolved at usage site
  txMeta?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Result from before-read interceptors
 */
export type BeforeReadInterceptorResult = {
  query: DatalogQuery;
  errors?: InterceptorError[];
  stopProcessing?: boolean;
};

/**
 * Before-read interceptor
 * Runs before query execution, can modify query or return errors
 */
export type BeforeReadInterceptor = {
  type: "beforeRead";
  name: string;
  execute: (
    query: DatalogQuery,
    ctx: ReadContext
  ) => Promise<BeforeReadInterceptorResult>;
};

/**
 * After-read interceptor
 * Runs after query execution, can filter/transform results
 */
export type AfterReadInterceptor = {
  type: "afterRead";
  name: string;
  execute: (datoms: Datom[], ctx: ReadContext) => Promise<Datom[]>;
};

/**
 * Result from before-write interceptors
 */
export type BeforeWriteInterceptorResult = {
  tx: Transaction;
  errors?: InterceptorError[];
  stopProcessing?: boolean;
};

/**
 * Before-write interceptor
 * Runs before transaction commit, can validate/augment transaction or return errors
 */
export type BeforeWriteInterceptor = {
  type: "beforeWrite";
  name: string;
  execute: (
    tx: Transaction,
    ctx: WriteContext
  ) => Promise<BeforeWriteInterceptorResult>;
};

/**
 * After-write interceptor
 * Runs after transaction commit, for side effects (failures don't fail transaction)
 */
export type AfterWriteInterceptor = {
  type: "afterWrite";
  name: string;
  execute: (tx: Transaction, ctx: WriteContext) => Promise<void>;
};

/**
 * Union type for all interceptor types
 */
export type Interceptor =
  | BeforeReadInterceptor
  | AfterReadInterceptor
  | BeforeWriteInterceptor
  | AfterWriteInterceptor;
