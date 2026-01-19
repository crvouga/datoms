/**
 * Hook-based logging utility for query editor
 * Registers database hooks to capture query and transact operations
 *
 * Note: For queries, hooks provide datoms (not final query results) since
 * query results are computed after hooks run. We wrap query/transact methods
 * minimally to capture actual results while using hooks for the logging infrastructure.
 */

import type { DatalogQuery } from "../../../../datalog/datalog.js";
import type { DatomDatabase } from "../../../../datom-database/datom-database.js";
import type {
  AfterRead,
  AfterWrite,
  BeforeRead,
  BeforeWrite,
  ReadContext,
  WriteContext,
} from "../../../../datom-database/hook/hook.js";
import type { QueryResult } from "../../../../datom-database/views/database-view.js";
import type { TransactionId } from "../../../../datoms.js";
import type { QueryEditorLog } from "../types.js";

/**
 * Options for database logging hooks
 */
export interface DatabaseLoggingOptions {
  /** Callback when a log entry is created */
  onLog: (log: QueryEditorLog) => void;
  /** Callback when an error occurs */
  onError?: (log: QueryEditorLog) => void;
}

/**
 * Tracks operation metadata using a Map keyed by operation ID
 */
interface OperationMetadata {
  id: number;
  timestamp: number;
  startTime: number;
  args: unknown[];
  method: "query" | "transact";
}

const operationMetadata = new Map<number, OperationMetadata>();

/**
 * Creates a logged database using hooks API
 * Wraps query/transact methods to capture results while hooks handle timing
 *
 * @param db - The database instance to wrap
 * @param options - Options including the log callback
 * @returns The database instance with logged query/transact methods
 */
export function createLoggedDatabaseWithHooks(
  db: DatomDatabase,
  options: DatabaseLoggingOptions
): DatomDatabase {
  const { onLog, onError } = options;
  let callIdCounter = 0;

  // Register hooks for timing (though we'll also wrap methods to capture results)
  const beforeReadHook: BeforeRead = {
    type: "beforeRead",
    name: "query-editor-logging-before-read",
    execute: async (query, ctx) => {
      const startTime = performance.now();
      const timestamp = Date.now();
      const callId = callIdCounter++;

      // Store metadata
      const metadata: OperationMetadata = {
        id: callId,
        timestamp,
        startTime,
        args: [query],
        method: "query",
      };
      operationMetadata.set(callId, metadata);

      // Store operation ID in context
      (ctx as ReadContext & { __logOperationId?: number }).__logOperationId =
        callId;

      return { query };
    },
  };

  const afterReadHook: AfterRead = {
    type: "afterRead",
    name: "query-editor-logging-after-read",
    execute: async (datoms, _ctx) => {
      // Hook timing is tracked, but actual results captured in wrapped method
      return { datoms };
    },
  };

  const beforeWriteHook: BeforeWrite = {
    type: "beforeWrite",
    name: "query-editor-logging-before-write",
    execute: async (tx, ctx) => {
      const startTime = performance.now();
      const timestamp = Date.now();
      const callId = callIdCounter++;

      // Transaction contains datoms, not ops
      const ops = tx.datoms || [];
      const metadata: OperationMetadata = {
        id: callId,
        timestamp,
        startTime,
        args: [ops],
        method: "transact",
      };
      operationMetadata.set(callId, metadata);

      (ctx as WriteContext & { __logOperationId?: number }).__logOperationId =
        callId;

      return { tx };
    },
  };

  const afterWriteHook: AfterWrite = {
    type: "afterWrite",
    name: "query-editor-logging-after-write",
    execute: async (_writeResult, _ctx) => {
      // Transaction logging handled in wrapped method
      return;
    },
  };

  // Register hooks
  db.hook(beforeReadHook);
  db.hook(afterReadHook);
  db.hook(beforeWriteHook);
  db.hook(afterWriteHook);

  // Wrap query and transact to capture results (hooks provide timing context)
  const originalQuery = db.query.bind(db);
  const originalTransact = db.transact.bind(db);

  db.query = async (
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> => {
    const startTime = performance.now();
    const timestamp = Date.now();
    const callId = callIdCounter++;

    try {
      const result = await originalQuery(query, {
        ...context,
        __logOperationId: callId,
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      const log: QueryEditorLog = {
        id: callId,
        timestamp,
        method: "query",
        args: [query],
        result,
        duration,
      };

      onLog(log);
      return result;
    } catch (err) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      const log: QueryEditorLog = {
        id: callId,
        timestamp,
        method: "query",
        args: [query],
        error: errorMessage,
        duration,
      };

      onError?.(log);
      throw err;
    }
  };

  db.transact = async (
    ops: Parameters<typeof originalTransact>[0],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId> => {
    const startTime = performance.now();
    const timestamp = Date.now();
    const callId = callIdCounter++;

    try {
      const result = await originalTransact(ops, metadata, {
        ...context,
        __logOperationId: callId,
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      const log: QueryEditorLog = {
        id: callId,
        timestamp,
        method: "transact",
        args: [ops],
        result,
        duration,
      };

      onLog(log);
      return result;
    } catch (err) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      const log: QueryEditorLog = {
        id: callId,
        timestamp,
        method: "transact",
        args: [ops],
        error: errorMessage,
        duration,
      };

      onError?.(log);
      throw err;
    }
  };

  return db;
}
