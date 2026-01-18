/**
 * Mock transport implementation for testing
 * Uses an in-memory database as the backend
 */

import type {
  InternalDatabaseView,
  ViewConfig,
} from "../../views/internal-database-view.js";
import { ConfiguredDatabaseView } from "../../views/internal-database-view.js";
import { ITransport, TransportError } from "./transport.js";
import type {
  DatomsRequest,
  DatomsResponse,
  GetLatestTransactionResponse,
  GetTransactionMetadataRequest,
  GetTransactionMetadataResponse,
  InitializeResponse,
  QueryRequest,
  QueryResponse,
  RegisterHookRequest,
  RegisterHookResponse,
  TransactRequest,
  TransactResponse,
} from "./types.js";

/**
 * Mock transport that uses an in-memory database as backend
 * Useful for testing RemoteDatomDatabase without a real server
 */
export class MockTransport implements ITransport {
  private backend: InternalDatabaseView;
  private initialized = false;

  constructor(backend: InternalDatabaseView) {
    this.backend = backend;
  }

  async request<TRequest, TResponse>(
    method: string,
    payload: TRequest
  ): Promise<TResponse> {
    // Ensure backend is initialized
    if (!this.initialized && method !== "initialize") {
      await this.backend.initialize();
      this.initialized = true;
    }

    try {
      switch (method) {
        case "initialize": {
          await this.backend.initialize();
          this.initialized = true;
          return {
            success: true,
          } as TResponse as InitializeResponse as TResponse;
        }

        case "datoms": {
          const datomsRequest = payload as DatomsRequest;
          // Handle speculative queries - need to merge speculative datoms with current state
          if (datomsRequest.viewConfig.type === "speculative") {
            // For speculative queries, we need to fetch current state and merge
            // This is handled by the RemoteDatomDatabase._executeSpeculativeQuery
            // But we can also handle it here for completeness
            const currentView = this._createView({ type: "current" });
            const currentDatoms = await currentView.datoms({});
            const speculativeDatoms = datomsRequest.viewConfig.datoms;

            // Merge speculative datoms with current state
            const mergedMap = new Map<string, (typeof speculativeDatoms)[0]>();
            for (const datom of currentDatoms) {
              const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
              mergedMap.set(key, datom);
            }

            for (const speculativeDatom of speculativeDatoms) {
              const key = `${String(speculativeDatom.e)}|${String(speculativeDatom.a)}|${JSON.stringify(speculativeDatom.v)}`;
              if (speculativeDatom.op === "retract") {
                mergedMap.delete(key);
              } else {
                mergedMap.set(key, speculativeDatom);
              }
            }

            const mergedDatoms = Array.from(mergedMap.values());
            // Apply filters from options
            let filtered = mergedDatoms;
            if (datomsRequest.options.e !== undefined) {
              filtered = filtered.filter(
                (d) => d.e === datomsRequest.options.e
              );
            }
            if (datomsRequest.options.a !== undefined) {
              filtered = filtered.filter(
                (d) => d.a === datomsRequest.options.a
              );
            }
            if (datomsRequest.options.v !== undefined) {
              filtered = filtered.filter(
                (d) => d.v === datomsRequest.options.v
              );
            }
            if (datomsRequest.options.tx !== undefined) {
              filtered = filtered.filter(
                (d) => d.tx === datomsRequest.options.tx
              );
            }
            if (datomsRequest.options.op !== undefined) {
              filtered = filtered.filter(
                (d) => d.op === datomsRequest.options.op
              );
            }

            return {
              datoms: filtered,
            } as TResponse as DatomsResponse as TResponse;
          }

          const view = this._createView(datomsRequest.viewConfig);
          const datoms = await view.datoms(datomsRequest.options);
          return { datoms } as TResponse as DatomsResponse as TResponse;
        }

        case "query": {
          const queryRequest = payload as QueryRequest;
          const view = this._createView(queryRequest.viewConfig);
          const results = await view.query(
            queryRequest.query,
            queryRequest.context
          );
          return { results } as TResponse as QueryResponse as TResponse;
        }

        case "transact": {
          const transactRequest = payload as TransactRequest;
          const txId = await this.backend.transact(
            transactRequest.ops,
            transactRequest.metadata,
            transactRequest.context
          );
          return { txId } as TResponse as TransactResponse as TResponse;
        }

        case "getLatestTransaction": {
          const txId = await this.backend.getLatestTransaction();
          return {
            txId,
          } as TResponse as GetLatestTransactionResponse as TResponse;
        }

        case "getTransactionMetadata": {
          const metadataRequest = payload as GetTransactionMetadataRequest;
          const metadata = await this.backend.getTransactionMetadata(
            metadataRequest.txId
          );
          return {
            metadata,
          } as TResponse as GetTransactionMetadataResponse as TResponse;
        }

        case "registerHook": {
          const hookRequest = payload as RegisterHookRequest;
          this.backend.hook(hookRequest.hook);
          return {
            success: true,
          } as TResponse as RegisterHookResponse as TResponse;
        }

        default:
          throw new TransportError(
            `Unknown method: ${method}`,
            "UNKNOWN_METHOD"
          );
      }
    } catch (error) {
      if (error instanceof Error) {
        // Map database errors to transport errors
        if (error.name === "QueryTimeoutError") {
          throw new TransportError(error.message, "QUERY_TIMEOUT", error);
        }
        if (error.name === "QuerySafetyError") {
          throw new TransportError(
            error.message,
            "QUERY_SAFETY_VIOLATION",
            error
          );
        }
        if (error.name === "TransactionError") {
          throw new TransportError(
            error.message,
            "TRANSACTION_HOOK_ERROR",
            error
          );
        }
        if (error.name === "QueryError") {
          throw new TransportError(error.message, "QUERY_HOOK_ERROR", error);
        }
        throw new TransportError(error.message, "DATABASE_ERROR", error);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.backend.close();
    this.initialized = false;
  }

  private _createView(viewConfig: ViewConfig) {
    return new ConfiguredDatabaseView(this.backend, viewConfig);
  }
}
