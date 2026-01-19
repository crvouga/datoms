/**
 * Datom database interface for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { Datom, DatomInput, TransactionId } from "../datoms.js";
import type { EntityId } from "../entity-id.js";
import type { Transaction } from "../types.js";
import type { Hook } from "./hook/hook.js";
import type { DatabaseView, DatomsQuery } from "./views/database-view.js";

/**
 * Datom database interface (Datomic-like minimal API)
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
 * class MyDb implements DatomDatabase { ... }
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
export interface DatomDatabase extends DatabaseView {
  /**
   * Initialize the database
   * @example
   * await db.initialize();
   */
  initialize(): Promise<void>;

  /**
   * Close the database and clean up resources
   * @example
   * await db.close();
   */
  close(): Promise<void>;

  /**
   * Register a database-level hook for validation, authorization, audit trails, etc.
   * Preferred over the old `.hook()` method. Call this at startup before transactions.
   *
   * @param hook The hook to register (see Hook type for details)
   * @example
   * db.hook(myValidatorHook);
   */
  hook(hook: Hook): void;

  /**
   * Execute bulk operations atomically (Datomic-like transact)
   * @param ops Array of operations, each specifying whether to assert or retract a datom
   * @param metadata Optional metadata to associate with this transaction
   * @param context Optional context object for hooks (can contain any data)
   * @returns The transaction ID
   * @example
   * await db.transact([
   *   { op: "assert", e: 300, a: "status", v: "active" },
   *   { op: "retract", e: 42, a: "type", v: "cat" }
   * ]);
   *
   * // With metadata and context
   * await db.transact(
   *   [{ op: "assert", e: 300, a: "status", v: "active" }],
   *   { userId: "alice", reason: "status_update" },
   *   { userId: "alice", syncSource: "client" }
   * );
   */
  transact(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId>;

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
  asOf(txId: TransactionId): DatabaseView;

  /**
   * Create a database view showing full history (all datoms, including sub)
   * Returns a read-only view that includes all historical changes without deduplication
   * @returns Read-only database view showing full history
   * @example
   * const dbHistory = db.history();
   * const allChanges = await dbHistory.datoms({ entity: 42 });
   * // Includes both add and sub datoms
   */
  history(): DatabaseView;

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
  since(txId: TransactionId): DatabaseView;

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
   *   { op: "assert", e: 1, a: "name", v: "Alice" },
   *   { op: "retract", e: 1, a: "oldName", v: "Bob" }
   * ]);
   *
   * // Query the speculative state
   * const datoms = await result.dbAfter.datoms({ entity: 1 });
   * // Preview what would change
   * console.log(result.txData);
   *
   * // To actually commit, use transact()
   * await db.transact([{ op: "assert", e: 1, a: "name", v: "Alice" }]);
   */
  with(ops: DatomInput[]): Promise<WithResult>;

  /**
   * Get the latest transaction in the database
   * Useful for synchronization, replication, and determining the current state
   * @returns The most recent transaction containing txId, datoms, and metadata
   * @example
   * const latestTx = await db._getLatestTransaction();
   * // Use for sync: only fetch changes after this transaction
   * const changes = await db.datoms({ tx: latestTx.txId! + 1 });
   * // Access transaction data
   * console.log(`Transaction ${latestTx.txId} has ${latestTx.datoms.length} datoms`);
   */
  _getLatestTransaction(): Promise<Transaction>;

  /**
   * Delete datoms from the database matching the given query.
   * @param query Query parameters to match datoms for deletion
   * @internal
   */
  _destroy(query: DatomsQuery): Promise<void>;
}

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
