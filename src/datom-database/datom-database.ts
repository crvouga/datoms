/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery, QueryResult } from "../datalog/datalog.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  Transaction,
  TransactionId,
  Value,
} from "../types.js";
import {
  InterceptorErrorWithName,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionError,
} from "./errors.js";
import { InterceptorEngine } from "./interceptor-engine.js";
import type { ReadContext, WriteContext } from "./interceptor-types.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "./shared/datalog-helpers.js";
import { joinResults, project } from "./shared/query-helpers.js";

/**
 * Minimal interface for reading datoms (Datomic-like)
 * Only core operations: datoms and query
 */
export interface DatomReader {
  /**
   * Query datoms from the database using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * // Query for all datoms with a specific entity ID
   * const datoms = await db.datoms({ entity: 123 });
   *
   * // Query with a filter and limit
   * const recent = await db.datoms({ attribute: "age", limit: 5 });
   *
   * // Time-travel query: use database views
   * const dbPast = db.asOf(87);
   * const atOldTx = await dbPast.datoms({ entity: 42 });
   */
  datoms(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query
   * @param query Datalog query to execute
   * @param context Optional context object for interceptors
   * @returns Query results as an array of records
   * @example
   * const results = await db.query({ find: ["?e"], where: [["?e", "name", "alice"]] });
   * //=> [{"e": 1}, {"e": 2}]
   */
  query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult>;
}

/**
 * Read-only database view for time-travel queries (Datomic-like)
 * Provides minimal interface for querying historical or filtered database states
 * Views are immutable and cannot modify the database
 */
export interface DatabaseView {
  /**
   * Query datoms from the database view using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * const dbPast = db.asOf(100);
   * const datoms = await dbPast.datoms({ entity: 123 });
   */
  datoms(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query against this database view
   * @param query Datalog query to execute
   * @param context Optional context object for interceptors
   * @returns Query results as an array of records
   * @example
   * const dbPast = db.asOf(100);
   * const results = await dbPast.query({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   */
  query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult>;
}

/**
 * Base class for database views that filter queries by transaction ID
 * Provides common functionality for AsOf, History, and Since views
 */
abstract class BaseDatabaseView implements DatabaseView {
  constructor(protected db: DatomDatabase) {}

  abstract datoms(options: QueryOptions): Promise<Datom[]>;

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    // Views need to execute queries using their filtered datoms() method
    // We'll execute the query manually using the view's datoms() method
    // Note: Views don't support interceptors yet - they use the base database's interceptors
    // through the db reference, but the context is passed through
    return this.executeQueryWithView(query, context);
  }

  /**
   * Execute a datalog query using the view's filtered datoms() method
   * This ensures time-travel filters are applied correctly
   */
  private async executeQueryWithView(
    query: DatalogQuery,
    _context?: Record<string, unknown>
  ): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    // Execute first clause using view's datoms() method
    const firstClause = query.where[0];
    if (!isQueryPattern(firstClause)) {
      throw new Error("First clause must be a QueryPattern");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = firstClause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    const firstDatoms = await this.datoms({
      e: entity,
      a: attribute,
      v: value,
    });

    // Map datom fields to variable names from the clause
    const firstResults = firstDatoms.map((datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom.e;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.a;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.v;
      }
      return result;
    });

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      if (!isQueryPattern(clause)) {
        throw new Error("Only QueryPattern clauses are supported in joins");
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const entity = isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const clauseDatoms = await this.datoms({
        e: entity,
        a: attribute,
        v: value,
      });

      const clauseResults = clauseDatoms.map((datom) => {
        const result: Record<string, Value | Attribute> = {};
        if (isVariable(entityVal)) {
          result[entityVal as string] = datom.e;
        }
        if (isVariable(attributeVal)) {
          result[attributeVal as string] = datom.a;
        }
        if (isVariable(valueVal)) {
          result[valueVal as string] = datom.v;
        }
        return result;
      });

      results = joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    // Project to find variables
    const projected = project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];
          if (aVal === undefined && bVal === undefined) return 0;
          if (aVal === undefined || aVal === null)
            return direction === "asc" ? 1 : -1;
          if (bVal === undefined || bVal === null)
            return direction === "asc" ? -1 : 1;
          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit if specified
    if (query.limit !== undefined) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }
}

/**
 * Database view showing state at a specific transaction ID (as-of query)
 * Filters queries to only include datoms with tx <= txId and deduplicates by (entity, attribute)
 */
class AsOfDatabaseView extends BaseDatabaseView {
  constructor(
    db: DatomDatabase,
    private txId: TransactionId
  ) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Use implementation-specific method for optimized SQL queries
    return this.db.executeAsOfQuery(options, this.txId);
  }
}

/**
 * Database view showing full history (all datoms, including sub)
 * No deduplication, includes all historical changes
 */
class HistoryDatabaseView extends BaseDatabaseView {
  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Use implementation-specific method for optimized SQL queries
    return this.db.executeHistoryQuery(options);
  }
}

/**
 * Database view showing only changes after a specific transaction ID (since query)
 * Filters queries to only include datoms with tx > txId
 */
class SinceDatabaseView extends BaseDatabaseView {
  constructor(
    db: DatomDatabase,
    private txId: TransactionId
  ) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Use implementation-specific method for optimized SQL queries
    return this.db.executeSinceQuery(options, this.txId);
  }
}

/**
 * Database view showing the current database state
 * Used by `with()` to represent dbBefore
 */
class CurrentDatabaseView extends BaseDatabaseView {
  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Use the database's internal query method via the public accessor
    return this.db._queryInternalForTransaction(options);
  }
}

/**
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
 */
class SpeculativeDatabaseView extends BaseDatabaseView {
  constructor(
    db: DatomDatabase,
    private speculativeAdds: Datom[],
    private speculativesubs: Datom[]
  ) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Get base datoms from the database
    const baseDatoms = await this.db._queryInternalForTransaction(options);

    // Create a map of base datoms by (entity, attribute, value) for efficient lookup
    const baseMap = new Map<string, Datom>();
    for (const datom of baseDatoms) {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
      const existing = baseMap.get(key);
      if (!existing || datom.tx > existing.tx) {
        baseMap.set(key, datom);
      }
    }

    // Apply subs first (remove matching datoms)
    for (const sub of this.speculativesubs) {
      const key = `${String(sub.e)}|${String(sub.a)}|${JSON.stringify(sub.v)}`;
      baseMap.delete(key);
    }

    // Apply adds (add or update datoms)
    for (const add of this.speculativeAdds) {
      const key = `${String(add.e)}|${String(add.a)}|${JSON.stringify(add.v)}`;
      baseMap.set(key, add);
    }

    // Convert back to array and apply filters
    let results = Array.from(baseMap.values());

    // Apply filters from options
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter(
        (d) => JSON.stringify(d.v) === JSON.stringify(options.v)
      );
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Apply op filter
    if (options.op === undefined || options.op === "add") {
      results = results.filter((d) => d.op === "add");
    } else if (options.op === "sub") {
      results = results.filter((d) => d.op === "sub");
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    if (limit !== undefined) {
      results = results.slice(offset, offset + limit);
    } else if (offset > 0) {
      results = results.slice(offset);
    }

    return results;
  }
}

/**
 * Abstract datom database class (Datomic-like minimal API)
 * Provides core operations: datoms, query, transact, and time-travel views
 * Concrete implementations: InMemoryDatabase, SQLiteDatabase, PostgreSQLDatabase
 *
 * **ACID Guarantees:**
 *
 * **Atomicity:** All operations within a transaction are atomic - either all succeed or all fail.
 * If any operation throws an error, the entire transaction is rolled back automatically.
 *
 * **Consistency:** Transactions maintain referential integrity.
 *
 * **Isolation:** Transactions use READ COMMITTED isolation by default (configurable via `isolationLevel`).
 * - **READ COMMITTED (default):** Prevents dirty reads. Within a transaction, reads see:
 *   - Committed changes from other transactions
 *   - Uncommitted changes from earlier operations in the same transaction
 *   - Does NOT see uncommitted changes from concurrent transactions
 * - **REPEATABLE READ:** All reads within a transaction see the same snapshot of data
 * - **SERIALIZABLE:** Highest isolation - prevents all concurrency anomalies
 * - **READ UNCOMMITTED:** Lowest isolation - allows dirty reads (not recommended)
 *
 * **Durability:** Once a transaction commits, changes are persisted. Implementations ensure
 * data survives crashes (for persistent backends).
 *
 * **Transaction Isolation Examples:**
 * ```typescript
 * // Concurrent transactions don't see each other's uncommitted changes
 * await Promise.all([
 *   db.transaction(async (tx1) => {
 *     await tx1.add([[1, "status", "pending"]]);
 *     // tx2 cannot see this until tx1 commits
 *   }),
 *   db.transaction(async (tx2) => {
 *     const status = await tx2.getValue(1, "status"); // undefined (tx1 not committed)
 *   })
 * ]);
 *
 * // Within a transaction, reads see earlier writes
 * await db.transaction(async (tx) => {
 *   await tx.add([[1, "name", "Alice"]]);
 *   const name = await tx.getValue(1, "name"); // "Alice" (sees uncommitted change)
 * });
 * ```
 *
 * **Concurrent Write Handling:**
 * - Optimistic locking via `expectedTxId` detects conflicts before commit
 * - Conflicts throw `TransactionConflictError` with retry support
 * - Implementations use database-level locking (row-level or table-level) as needed
 * - Deadlock detection and resolution is backend-specific
 *
 * **Observability:**
 * - Event system for monitoring transactions, queries, and errors
 * - Database statistics via `getStats()` for performance monitoring
 * - Query and transaction metrics are tracked automatically
 * - Health checks via `healthCheck()` for operational monitoring
 *
 * **Backup & Recovery:**
 * - Export datoms via `export()` for backup and replication
 * - Import datoms via `import()` for restore
 * - Supports streaming for large datasets
 *
 * **Connection Pooling (SQL Implementations):**
 * - SQL database implementations should use connection pooling for production workloads
 * - Configure pools using `ConnectionPoolConfig` type (defined in `../types.js`) with appropriate limits
 * - Monitor pool health via `getPoolStats()` if implemented by your SQL adapter
 * - **Best Practices:**
 *   - Use connection pooling for multi-threaded/server applications
 *   - Single connections are fine for CLI tools or single-user applications
 *   - Set `maxConnections` based on your database server's connection limits
 *   - Monitor `waitingRequests` to detect connection pool exhaustion
 *   - Use `idleTimeout` and `maxLifetime` to prevent connection leaks
 *
 * **EntityId Types:**
 * - `EntityId` supports `number` and `string` types
 *
 * **Query Performance:**
 * - Query timeouts via `timeoutMs` option prevent runaway queries
 * - Result size limits via `maxResultSize` prevent memory exhaustion
 * - Query safety checks prevent accidental full table scans
 *
 * @example
 * // Example usage: Create, add and query
 * class MyDb extends DatomDatabase { ... }
 * const db = new MyDb();
 * await db.initialize();
 *
 * // Listen to events
 * db.on("transaction", (event) => {
 *   console.log(`Transaction ${event.txId} completed`);
 * });
 *
 * await db.add([[1, "name", "Alice"]]);
 * const name = await db.getValue(1, "name"); // "Alice"
 *
 * // Get statistics
 * const stats = await db.getStats();
 * console.log(`Total datoms: ${stats.totalDatoms}`);
 *
 * // Health check
 * const health = await db.healthCheck();
 * console.log(`Database status: ${health.status}`);
 */
/**
 * Result of a speculative transaction using the `with()` method (Datomic-like)
 * Provides a read-only view of what the database would look like after applying the transaction
 * without actually committing the changes
 */
export interface WithResult {
  /** The database state before applying the transaction (read-only view) */
  dbBefore: DatabaseView;
  /** The database state after applying the transaction (read-only speculative view) */
  dbAfter: DatabaseView;
  /** The datoms that would be applied by this transaction */
  txData: Datom[];
  /** Map of temporary IDs to resolved entity IDs (empty for now, reserved for future tempid support) */
  tempIds: Record<string, EntityId>;
}

export abstract class DatomDatabase implements DatomReader {
  protected initialized = false;
  public readonly interceptors: InterceptorEngine;

  constructor() {
    this.interceptors = new InterceptorEngine();
  }

  /**
   * Initialize the database
   * @example
   * await db.initialize();
   */
  abstract initialize(): Promise<void>;

  /**
   * Close the database and clean up resources
   * @example
   * await db.close();
   */
  abstract close(): Promise<void>;

  /**
   * Implementation-specific method to add datoms after validation.
   * Subclasses should override this method.
   * @param datoms Array of validated datoms to add
   * @returns The transaction ID
   * @internal
   */
  protected abstract addDatoms(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Implementation-specific method to sub datoms after validation.
   * Subclasses should override this method.
   * @param datoms Array of validated datoms to sub
   * @returns The transaction ID
   * @internal
   */
  protected abstract subDatoms(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Execute bulk operations atomically (Datomic-like transact)
   * @param ops Array of operations, each specifying whether to add or sub a datom
   * @param metadata Optional metadata to associate with this transaction
   * @param context Optional context object for interceptors (can contain any data)
   * @returns The transaction ID
   * @example
   * await db.transact([
   *   { op: "add", e: 300, a: "status", v: "active" },
   *   { op: "sub", e: 42, a: "type", v: "cat" }
   * ]);
   *
   * // With metadata and context
   * await db.transact(
   *   [{ op: "add", e: 300, a: "status", v: "active" }],
   *   { userId: "alice", reason: "status_update" },
   *   { userId: "alice", syncSource: "client" }
   * );
   */
  async transact(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId> {
    await this.ensureInitialized();

    // Create write context
    const ctx: WriteContext = {
      db: this,
      txMeta: metadata,
      ...(context || {}),
    };

    // Process operations sequentially
    const adds: DatomInput[] = [];
    const subs: DatomInput[] = [];

    for (const op of ops.flat()) {
      const datom = { e: op.e, a: op.a, v: op.v, op: op.op };

      if (op.op === "add") {
        // Validate add, accounting for subs already processed
        await this.validateDatoms([datom], true, subs);
        adds.push(datom);
      } else {
        // Validate sub
        await this.validateDatoms([datom], false);
        subs.push(datom);
      }
    }

    // Convert to datoms for transaction object
    const allDatoms: Datom[] = [];
    const latestTx = await this.getLatestTransaction();
    const txId = latestTx + 1;

    for (const sub of subs) {
      allDatoms.push({
        e: sub.e,
        a: sub.a,
        v: sub.v,
        tx: txId,
        op: "sub",
      });
    }

    for (const add of adds) {
      allDatoms.push({
        e: add.e,
        a: add.a,
        v: add.v,
        tx: txId,
        op: "add",
      });
    }

    // Create transaction object
    const tx: Transaction = {
      datoms: allDatoms,
      meta: metadata,
    };

    // Run before-write interceptors
    const beforeResult = await this.interceptors.runBeforeWrite(tx, ctx);

    if (beforeResult.errors.length > 0) {
      throw new TransactionError(
        "Transaction validation failed",
        beforeResult.errors as InterceptorErrorWithName[]
      );
    }

    // Apply subs first, then adds (using the modified transaction from interceptors)
    const finalTx = beforeResult.tx;
    const finalSubs = finalTx.datoms.filter((d) => d.op === "sub");
    const finalAdds = finalTx.datoms.filter((d) => d.op === "add");

    let committedTxId: TransactionId;
    if (finalSubs.length > 0) {
      committedTxId = await this.subDatoms(
        finalSubs.map((d) => ({ e: d.e, a: d.a, v: d.v, op: d.op }))
      );
    }
    if (finalAdds.length > 0) {
      committedTxId = await this.addDatoms(
        finalAdds.map((d) => ({ e: d.e, a: d.a, v: d.v, op: d.op }))
      );
    } else if (finalSubs.length === 0) {
      // If there are no operations, still create a new transaction ID
      committedTxId = await this.addDatoms([]);
    } else {
      committedTxId = committedTxId!;
    }

    // Store metadata if provided
    if (metadata !== undefined) {
      await this.onTransactionMetadata(committedTxId, metadata);
    }

    // Create committed transaction object for after-write interceptors
    const committedTx: Transaction = {
      datoms: finalTx.datoms.map((d) => ({ ...d, tx: committedTxId })),
      meta: metadata,
    };

    // Run after-write interceptors (fire and forget, don't block)
    this.interceptors.runAfterWrite(committedTx, ctx).catch((err) => {
      console.error("After-write interceptor failed:", err);
    });

    return committedTxId;
  }

  /**
   * Hook for implementations to store transaction metadata.
   * Called after a transaction commits successfully.
   *
   * **Optional Implementation:** This method is optional - implementations can override
   * it to persist metadata if needed. The default implementation is a no-op, meaning
   * metadata is ignored unless the implementation provides storage.
   *
   * **Note:** Metadata is still emitted in transaction events even if not persisted,
   * so event listeners can access it regardless of whether this method is overridden.
   *
   * @param txId The transaction ID
   * @param metadata The metadata object provided to transact()
   * @example
   * // Override in your subclass to store metadata:
   * protected async onTransactionMetadata(
   *   txId: TransactionId,
   *   metadata: Record<string, unknown>
   * ): Promise<void> {
   *   await this.metadataTable.insert({ txId, ...metadata });
   * }
   */
  protected async onTransactionMetadata(
    _txId: TransactionId,
    _metadata: Record<string, unknown>
  ): Promise<void> {
    // Optional: Override in implementations if metadata storage is needed
    // Default: no-op (metadata is ignored but still emitted in events)
  }

  /**
   * Get metadata associated with a transaction
   * @param txId Transaction ID
   * @returns Metadata object or undefined if no metadata was stored
   * @example
   * const metadata = await db.getTransactionMetadata(123);
   * // Returns: { userId: "alice", reason: "update" } or undefined
   */
  abstract getTransactionMetadata(
    txId: TransactionId
  ): Promise<Record<string, unknown> | undefined>;

  /**
   * Get the latest transaction ID in the database
   * Useful for synchronization, replication, and determining the current state
   * @returns The most recent transaction ID, or 0 if no transactions have occurred
   * @example
   * const latestTx = await db.getLatestTransaction();
   * // Use for sync: only fetch changes after this transaction
   * const changes = await db.datoms({ tx: latestTx + 1 });
   */
  abstract getLatestTransaction(): Promise<TransactionId>;

  /**
   * Query datoms from the database using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * // Query by filters to prevent accidental full table scan:
   * const datoms = await db.datoms({ attribute: "name", value: "Alice" });
   *
   * // Pagination example:
   * const page1 = await db.datoms({ attribute: "status", limit: 10, offset: 0 });
   * const page2 = await db.datoms({ attribute: "status", limit: 10, offset: 10 });
   */
  async datoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }

    // Execute query with timeout if specified
    let results: Datom[];
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new QueryTimeoutError(options.timeoutMs!, options));
        }, options.timeoutMs);
      });

      const queryPromise = this.executeQuery(options);
      results = await Promise.race([queryPromise, timeoutPromise]);
    } else {
      results = await this.executeQuery(options);
    }

    // Check result size limit if specified
    if (
      options.maxResultSize !== undefined &&
      results.length > options.maxResultSize
    ) {
      throw new QueryResultSizeError(
        results.length,
        options.maxResultSize,
        options
      );
    }

    return results;
  }

  /**
   * Internal query method that bypasses validation.
   * Used by datalog queries and transactions where validation is not needed.
   * This is protected and should only be used by subclasses - external consumers should use query() instead.
   * @param options Query options
   * @returns Array of matching datoms
   * @example
   * // Used internally in datalog or in transaction implementations:
   * const datoms = await this.queryInternal({ entity: 42 });
   */
  protected async queryInternal(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    return this.executeQuery(options);
  }

  /**
   * Internal method for transaction classes to access queryInternal.
   * This is public but marked as internal-use-only. External consumers should use query() instead.
   * @internal
   */
  public _queryInternalForTransaction(options: QueryOptions): Promise<Datom[]> {
    return this.queryInternal(options);
  }

  /**
   * Get raw datoms without deduplication for time-travel queries.
   * This method is used by database views to get all datoms matching filters
   * before applying time-travel specific deduplication logic.
   * Implementations should override this to provide undeduplicated results.
   * @internal
   */
  public async getRawDatoms(options: QueryOptions): Promise<Datom[]> {
    // Default implementation: use executeQuery but implementations can override
    // to provide undeduplicated results. For now, we'll use executeQuery with op: undefined
    // to get all datoms including sub ones, then the view will handle deduplication.
    return this.executeQuery({
      ...options,
      op: undefined, // Get all datoms including sub
    });
  }

  /**
   * Execute an asOf query - returns datoms with tx <= txId, deduplicated by (entity, attribute).
   * This method is called by AsOfDatabaseView to leverage database-native query optimization.
   * @param options Query options
   * @param txId Transaction ID to query as-of
   * @returns Array of matching datoms deduplicated by (entity, attribute)
   * @internal
   */
  public async executeAsOfQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]> {
    // Default implementation: use getRawDatoms and filter/deduplicate in JavaScript
    // SQL implementations should override this for better performance
    const allDatoms = await this.getRawDatoms({
      ...options,
      tx: undefined, // Remove tx filter, we'll apply our own
    });

    // Filter to only datoms with tx <= txId
    // If options.tx is specified, use the minimum of both
    const maxTx = options.tx !== undefined ? Math.min(options.tx, txId) : txId;
    const filtered = allDatoms.filter((d) => d.tx <= maxTx);

    // Deduplicate by (entity, attribute) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of filtered) {
      const key = `${String(datom.e)}|${String(datom.a)}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out sub datoms (keep only op: "add")
    return Array.from(deduplicated.values()).filter((d) => d.op === "add");
  }

  /**
   * Execute a history query - returns all datoms including sub, without deduplication.
   * This method is called by HistoryDatabaseView to leverage database-native query optimization.
   * @param options Query options
   * @returns Array of all matching datoms (including sub)
   * @internal
   */
  public async executeHistoryQuery(options: QueryOptions): Promise<Datom[]> {
    // Default implementation: use getRawDatoms
    // SQL implementations should override this for better performance
    return this.getRawDatoms({
      ...options,
      op: undefined, // Don't filter by add/sub
    });
  }

  /**
   * Execute a since query - returns datoms with tx > txId, deduplicated by (entity, attribute, value).
   * This method is called by SinceDatabaseView to leverage database-native query optimization.
   * @param options Query options
   * @param txId Transaction ID - only changes after this will be included
   * @returns Array of matching datoms deduplicated by (entity, attribute, value)
   * @internal
   */
  public async executeSinceQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]> {
    // Default implementation: use getRawDatoms and filter/deduplicate in JavaScript
    // SQL implementations should override this for better performance
    const allDatoms = await this.getRawDatoms({
      ...options,
      tx: undefined, // Remove tx filter if present
    });

    // Filter to only datoms with tx > txId
    const filtered = allDatoms.filter((d) => d.tx > txId);

    // Deduplicate by (entity, attribute, value) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of filtered) {
      const valueKey = JSON.stringify(datom.v);
      const key = `${String(datom.e)}|${String(datom.a)}|${valueKey}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out sub datoms (keep only op: "add")
    return Array.from(deduplicated.values()).filter((d) => d.op === "add");
  }

  /**
   * Validate datoms - basic runtime checks for null/undefined (defensive programming)
   * TypeScript guarantees types, but runtime checks catch cases where types are bypassed (e.g., `as any`)
   * @param datoms Array of datoms to validate
   * @param _isAdd Whether these datoms are being add (true) or sub (false)
   * @param _subsInSameTransaction Optional subs in the same transaction
   */
  protected async validateDatoms(
    datoms: DatomInput[],
    _isAdd: boolean,
    _subsInSameTransaction?: DatomInput[]
  ): Promise<void> {
    // Basic runtime validation for cases where TypeScript types are bypassed
    for (const datom of datoms) {
      if (datom.e === null || datom.e === undefined) {
        throw new Error("Datom must have an entity ID");
      }
      if (datom.a === null || datom.a === undefined) {
        throw new Error("Datom must have an attribute");
      }
    }
  }

  /**
   * Execute the actual query (implemented by subclasses)
   * @example
   * // Implement in your custom DB class
   * protected async executeQuery(options: QueryOptions): Promise<Datom[]> { ... }
   */
  protected abstract executeQuery(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query
   * @param query Datalog query to execute
   * @param context Optional context object for interceptors (can contain any data)
   * @returns Query results as an array of records with keys that have the question mark prefix stripped
   * @example
   * const result = await db.query({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   * // result will be [{"e": 123}] not [{"?e": 123}]
   *
   * // With context for interceptors
   * const result = await db.query(
   *   { find: ["?e"], where: [["?e", "name", "Alice"]] },
   *   { userId: "alice", syncTarget: "client" }
   * );
   */
  abstract query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult>;

  /**
   * Helper method for implementations to handle query interceptors
   * Extracts datoms from query execution, runs afterRead interceptors, then projects to results
   * @param query The datalog query
   * @param context Optional context for interceptors
   * @param extractDatoms Function that extracts datoms from the query (before projection)
   * @param projectToResults Function that projects filtered datoms to QueryResult
   * @returns Query results after interceptors
   * @internal
   */
  protected async executeQueryWithInterceptors(
    query: DatalogQuery,
    context: Record<string, unknown> | undefined,
    extractDatoms: (query: DatalogQuery) => Promise<Datom[]>,
    projectToResults: (datoms: Datom[], query: DatalogQuery) => QueryResult
  ): Promise<QueryResult> {
    // Create read context
    const ctx: ReadContext = {
      db: this,
      ...(context || {}),
    };

    // Run before-read interceptors
    const beforeResult = await this.interceptors.runBeforeRead(query, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError(
        "Query blocked by interceptors",
        beforeResult.errors as InterceptorErrorWithName[]
      );
    }

    // Extract datoms from the modified query
    const rawDatoms = await extractDatoms(beforeResult.query);

    // Run after-read interceptors
    const filteredDatoms = await this.interceptors.runAfterRead(rawDatoms, ctx);

    // Project filtered datoms back to QueryResult
    return projectToResults(filteredDatoms, beforeResult.query);
  }

  /**
   * Create a database view showing the state at a specific transaction ID
   * Returns a read-only view that filters all queries to only include datoms
   * with transaction ID <= txId
   * @param txId Transaction ID to query as-of
   * @returns Read-only database view
   * @example
   * const dbPast = db.asOf(100);
   * const datoms = await dbPast.datoms({ entity: 42 });
   * const results = await dbPast.query({ find: ["?v"], where: [[42, "name", "?v"]] });
   */
  asOf(txId: TransactionId): DatabaseView {
    return new AsOfDatabaseView(this, txId);
  }

  /**
   * Create a database view showing full history (all datoms, including sub)
   * Returns a read-only view that includes all historical changes without deduplication
   * @returns Read-only database view showing full history
   * @example
   * const dbHistory = db.history();
   * const allChanges = await dbHistory.datoms({ entity: 42 });
   * // Includes both add and sub datoms
   */
  history(): DatabaseView {
    return new HistoryDatabaseView(this);
  }

  /**
   * Create a database view showing only changes after a specific transaction ID
   * Returns a read-only view that filters all queries to only include datoms
   * with transaction ID > txId
   * @param txId Transaction ID - only changes after this will be included
   * @returns Read-only database view
   * @example
   * const dbSince = db.since(100);
   * const recentChanges = await dbSince.datoms({ entity: 42 });
   */
  since(txId: TransactionId): DatabaseView {
    return new SinceDatabaseView(this, txId);
  }

  /**
   * Speculatively apply transaction data to the database (Datomic-like `with`)
   * Returns a read-only view of what the database would look like after applying
   * the transaction without actually committing the changes.
   *
   * **Speculative Transactions:**
   * - `with()` is purely speculative - it does not commit any changes
   * - Use `with()` to validate transaction data, preview changes, or build up transaction data
   * - The returned `dbAfter` view can be queried to see what the database would look like
   * - To actually commit changes, use `transact()` instead
   *
   * **Return Value:**
   * - `dbBefore`: Read-only view of the database state before applying the transaction
   * - `dbAfter`: Read-only view of the database state after applying the transaction (speculative)
   * - `txData`: The datoms that would be applied by this transaction
   * - `tempIds`: Map of temporary IDs to resolved entity IDs (empty for now)
   *
   * @param ops Array of transaction operations
   * @returns Result containing dbBefore, dbAfter, txData, and tempIds
   * @example
   * // Speculate on a transaction
   * const result = await db.with([
   *   { op: "add", e: 1, a: "name", v: "Alice" },
   *   { op: "sub", e: 1, a: "oldName", v: "Bob" }
   * ]);
   *
   * // Query the speculative state
   * const datoms = await result.dbAfter.datoms({ entity: 1 });
   * // Preview what would change
   * console.log(result.txData);
   *
   * // To actually commit, use transact()
   * await db.transact([{ op: "add", e: 1, a: "name", v: "Alice" }]);
   */
  async with(ops: DatomInput[]): Promise<WithResult> {
    await this.ensureInitialized();

    // Get the next transaction ID for speculative datoms
    const speculativeTxId = (await this.getLatestTransaction()) + 1;

    // Process operations in sequence, creating speculative datoms directly
    const speculativeAdds: Datom[] = [];
    const speculativesubs: Datom[] = [];

    for (const op of ops) {
      const speculativeDatom: Datom = {
        e: op.e,
        a: op.a,
        v: op.v,
        tx: speculativeTxId,
        op: op.op,
      };

      if (op.op === "add") {
        speculativeAdds.push(speculativeDatom);
      } else {
        speculativesubs.push(speculativeDatom);
      }
    }

    // Create dbBefore view (current state)
    const dbBefore = new CurrentDatabaseView(this);

    // Create dbAfter view (speculative state)
    const dbAfter = new SpeculativeDatabaseView(
      this,
      speculativeAdds,
      speculativesubs
    );

    // Generate txData (all datoms that would be applied)
    const txData: Datom[] = [...speculativesubs, ...speculativeAdds];

    return {
      dbBefore,
      dbAfter,
      txData,
      tempIds: {}, // Empty for now, reserved for future tempid support
    };
  }

  /**
   * Validate an EntityId value
   * Checks that the EntityId is a valid type (number or string)
   * @param entityId EntityId to validate
   * @returns True if valid
   * @throws Error if invalid
   * @example
   * db.validateEntityId(123); // OK
   * db.validateEntityId("user-123"); // OK
   * db.validateEntityId(null); // Throws error
   */
  validateEntityId(entityId: unknown): entityId is EntityId {
    if (typeof entityId === "number" || typeof entityId === "string") {
      return true;
    }
    throw new Error(
      `Invalid EntityId type: expected number or string, got ${typeof entityId}`
    );
  }

  /**
   * Serialize an EntityId to a string for storage
   * @param entityId EntityId to serialize
   * @returns Serialized string representation
   * @internal
   */
  public serializeEntityId(entityId: EntityId): string {
    return String(entityId);
  }

  /**
   * Deserialize a string to an EntityId
   * @param serialized Serialized string representation
   * @returns Deserialized EntityId
   * @internal
   */
  public deserializeEntityId(serialized: string): EntityId {
    // Try to parse as number first
    const num = Number(serialized);
    if (!isNaN(num) && isFinite(num) && String(num) === serialized) {
      return num;
    }
    return serialized;
  }

  /**
   * Ensure the database is initialized
   * @example
   * await db.ensureInitialized();
   */
  protected async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
