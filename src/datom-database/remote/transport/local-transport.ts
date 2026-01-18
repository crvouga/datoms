/**
 * Mock transport implementation for testing
 * Uses an in-memory database as the backend
 */

import type {
  InternalDatabaseView,
  ViewConfig,
} from "../../views/internal-database-view.js";
import { ConfiguredDatabaseView } from "../../views/internal-database-view.js";
import type {
  ITransport,
  DatomsRequest,
  DatomsResponse,
  GetLatestTransactionResponse,
  GetTransactionMetadataRequest,
  GetTransactionMetadataResponse,
  GetObsoleteDatomsRequest,
  GetObsoleteDatomsResponse,
  DeleteDatomsRequest,
  DeleteDatomsResponse,
  InitializeResponse,
  QueryRequest,
  QueryResponse,
  RegisterHookRequest,
  RegisterHookResponse,
  TransactRequest,
  TransactResponse,
} from "./transport.js";
import { TransportError } from "./transport.js";

/**
 * Mock transport that uses an in-memory database as backend
 * Useful for testing RemoteDatomDatabase without a real server
 */
export class LocalTransport implements ITransport {
  private backend: InternalDatabaseView;
  private initialized = false;

  constructor(backend: InternalDatabaseView) {
    this.backend = backend;
  }

  async initialize(): Promise<InitializeResponse> {
    await this.backend.initialize();
    this.initialized = true;
    return { success: true };
  }

  async datoms(request: DatomsRequest): Promise<DatomsResponse> {
    await this._ensureInitialized();

    try {
      // Handle speculative queries - need to merge speculative datoms with current state
      if (request.viewConfig.type === "speculative") {
        // For speculative queries, we need to fetch current state and merge
        // This is handled by the RemoteDatomDatabase._executeSpeculativeQuery
        // But we can also handle it here for completeness
        const currentView = this._createView({ type: "current" });
        const currentDatoms = await currentView.datoms({});
        const speculativeDatoms = request.viewConfig.datoms;

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
        if (request.options.e !== undefined) {
          filtered = filtered.filter((d) => d.e === request.options.e);
        }
        if (request.options.a !== undefined) {
          filtered = filtered.filter((d) => d.a === request.options.a);
        }
        if (request.options.v !== undefined) {
          filtered = filtered.filter((d) => d.v === request.options.v);
        }
        if (request.options.tx !== undefined) {
          filtered = filtered.filter((d) => d.tx === request.options.tx);
        }
        if (request.options.op !== undefined) {
          filtered = filtered.filter((d) => d.op === request.options.op);
        }

        return { datoms: filtered };
      }

      const view = this._createView(request.viewConfig);
      const datoms = await view.datoms(request.options);
      return { datoms };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    await this._ensureInitialized();

    try {
      const view = this._createView(request.viewConfig);
      const results = await view.query(request.query, request.context);
      return { results };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async transact(request: TransactRequest): Promise<TransactResponse> {
    await this._ensureInitialized();

    try {
      const txId = await this.backend.transact(
        request.ops,
        request.metadata,
        request.context
      );
      return { txId };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async getLatestTransaction(): Promise<GetLatestTransactionResponse> {
    await this._ensureInitialized();

    try {
      const txId = await this.backend.getLatestTransaction();
      return { txId };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async getTransactionMetadata(
    request: GetTransactionMetadataRequest
  ): Promise<GetTransactionMetadataResponse> {
    await this._ensureInitialized();

    try {
      const metadata = await this.backend.getTransactionMetadata(request.txId);
      return { metadata };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async registerHook(
    request: RegisterHookRequest
  ): Promise<RegisterHookResponse> {
    await this._ensureInitialized();

    try {
      this.backend.hook(request.hook);
      return { success: true };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async getObsoleteDatoms(
    request: GetObsoleteDatomsRequest
  ): Promise<GetObsoleteDatomsResponse> {
    await this._ensureInitialized();

    try {
      const datoms = await this.backend.getObsoleteDatoms(request.cutoffTx);
      return { datoms };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async deleteDatoms(
    request: DeleteDatomsRequest
  ): Promise<DeleteDatomsResponse> {
    await this._ensureInitialized();

    try {
      await this.backend.deleteDatoms(request.datoms);
      return { success: true };
    } catch (error) {
      throw this._mapError(error);
    }
  }

  async close(): Promise<void> {
    await this.backend.close();
    this.initialized = false;
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.backend.initialize();
      this.initialized = true;
    }
  }

  private _createView(viewConfig: ViewConfig) {
    return new ConfiguredDatabaseView(this.backend, viewConfig);
  }

  private _mapError(error: unknown): TransportError {
    if (error instanceof Error) {
      // Map database errors to transport errors
      if (error.name === "QueryTimeoutError") {
        return new TransportError(error.message, "QUERY_TIMEOUT", error);
      }
      if (error.name === "QuerySafetyError") {
        return new TransportError(
          error.message,
          "QUERY_SAFETY_VIOLATION",
          error
        );
      }
      if (error.name === "TransactionError") {
        return new TransportError(
          error.message,
          "TRANSACTION_HOOK_ERROR",
          error
        );
      }
      if (error.name === "QueryError") {
        return new TransportError(error.message, "QUERY_HOOK_ERROR", error);
      }
      return new TransportError(error.message, "DATABASE_ERROR", error);
    }
    return new TransportError(String(error), "DATABASE_ERROR", error);
  }
}
