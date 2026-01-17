/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery, QueryResult } from "../datalog/datalog.js";
import type {
  Attribute,
  AttributeDefinition,
  Datom,
  DatomInput,
  EntityId,
  Migration,
  MigrationState,
  QueryOptions,
  SchemaExport,
  TransactionId,
  Value,
} from "../types.js";
import {
  CardinalityError,
  DatomTypeError,
  MigrationError,
  MigrationRollbackError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  UniqueConstraintError,
} from "./errors.js";
import { MigrationRegistry } from "./migrations/migration-registry.js";
import { isVariable, stripQuestionMark } from "./shared/datalog-helpers.js";
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
   * @returns Query results as an array of records
   * @example
   * const results = await db.query({ find: ["?e"], where: [["?e", "name", "alice"]] });
   * //=> [{"e": 1}, {"e": 2}]
   */
  query(query: DatalogQuery): Promise<QueryResult>;
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
   * @returns Query results as an array of records
   * @example
   * const dbPast = db.asOf(100);
   * const results = await dbPast.query({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   */
  query(query: DatalogQuery): Promise<QueryResult>;
}

/**
 * Result of a transaction operation
 */
export interface TransactResult {
  /** The transaction ID */
  txId: TransactionId;
  /** Number of datoms added */
  addedCount: number;
  /** Number of datoms retracted */
  retractedCount: number;
}

/**
 * Base class for database views that filter queries by transaction ID
 * Provides common functionality for AsOf, History, and Since views
 */
abstract class BaseDatabaseView implements DatabaseView {
  constructor(protected db: DatomDatabase) { }

  abstract datoms(options: QueryOptions): Promise<Datom[]>;

  async query(query: DatalogQuery): Promise<QueryResult> {
    // Views need to execute queries using their filtered datoms() method
    // We'll execute the query manually using the view's datoms() method
    return this.executeQueryWithView(query);
  }

  /**
   * Execute a datalog query using the view's filtered datoms() method
   * This ensures time-travel filters are applied correctly
   */
  private async executeQueryWithView(
    query: DatalogQuery
  ): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    // Execute first clause using view's datoms() method
    const firstClause = query.where[0];
    const [entityVal, attributeVal, valueVal] = firstClause;
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
      const [entityVal, attributeVal, valueVal] = clause;
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
 * Database view showing full history (all datoms, including retracted)
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
 * Merges base database state with speculative adds and retracts
 * Used by the `with()` method for speculative transactions
 */
class SpeculativeDatabaseView extends BaseDatabaseView {
  constructor(
    db: DatomDatabase,
    private speculativeAdds: Datom[],
    private speculativeRetracts: Datom[]
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

    // Apply retracts first (remove matching datoms)
    for (const retract of this.speculativeRetracts) {
      const key = `${String(retract.e)}|${String(retract.a)}|${JSON.stringify(retract.v)}`;
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

    // Apply added filter
    if (options.added === undefined || options.added === true) {
      results = results.filter((d) => d.added);
    } else if (options.added === false) {
      results = results.filter((d) => !d.added);
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
 * Transaction operations format for transact() method
 * Array of operations, each specifying whether to add or retract a datom
 */
export type TransactOperations = Array<
  | { op: "added"; e: EntityId; a: Attribute; v: Value }
  | { op: "retracted"; e: EntityId; a: Attribute; v: Value }
>;

/**
 * Abstract datom database class that provides a high-level interface
 * for working with datoms and datalog queries
 * Concrete implementations: InMemoryDatabase, SQLiteDatabase, PostgreSQLDatabase
 *
 * **ACID Guarantees:**
 *
 * **Atomicity:** All operations within a transaction are atomic - either all succeed or all fail.
 * If any operation throws an error, the entire transaction is rolled back automatically.
 *
 * **Consistency:** Schema constraints (type, cardinality, uniqueness) are enforced within transactions.
 * Invalid data cannot be committed. Transactions maintain referential integrity.
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
 * **Schema Enforcement:**
 * - Attributes can be used without schema definitions (schema is optional)
 * - When an attribute is defined, validation is enforced (type, cardinality, uniqueness)
 * - Use `defineAttribute()` to add schema constraints, or work without schema for flexibility
 * - Schema migrations are supported via `migrate()` and `getSchemaVersion()`
 *
 * **Observability:**
 * - Event system for monitoring transactions, queries, errors, and migrations
 * - Database statistics via `getStats()` for performance monitoring
 * - Query and transaction metrics are tracked automatically
 * - Health checks via `healthCheck()` for operational monitoring
 *
 * **Backup & Recovery:**
 * - Export datoms via `export()` for backup and replication
 * - Import datoms via `import()` for restore and migration
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
 * Abstract datom database class (Datomic-like minimal API)
 * Provides core operations: datoms, query, transact, and time-travel views
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
  protected schema: Map<string, AttributeDefinition> = new Map();
  protected schemaVersion: number = 0;
  /** Migration registry for managing migrations */
  protected migrationRegistry: MigrationRegistry = new MigrationRegistry();

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
   * Implementation-specific method to retract datoms after validation.
   * Subclasses should override this method.
   * @param datoms Array of validated datoms to retract
   * @returns The transaction ID
   * @internal
   */
  protected abstract retractDatoms(
    datoms: DatomInput[]
  ): Promise<TransactionId>;

  /**
   * Execute bulk operations atomically (Datomic-like transact)
   * @param ops Array of operations, each specifying whether to add or retract a datom
   * @param metadata Optional metadata to associate with this transaction
   * @returns The transaction ID
   * @example
   * await db.transact([
   *   { op: "added", e: 300, a: "status", v: "active" },
   *   { op: "retracted", e: 42, a: "type", v: "cat" }
   * ]);
   *
   * // With metadata
   * await db.transact(
   *   [{ op: "added", e: 300, a: "status", v: "active" }],
   *   { userId: "alice", reason: "status_update" }
   * );
   */
  async transact(
    ops: TransactOperations,
    metadata?: Record<string, unknown>
  ): Promise<TransactionId> {
    await this.ensureInitialized();

    // Separate operations by type
    const adds: DatomInput[] = [];
    const retracts: DatomInput[] = [];

    for (const op of ops) {
      if (op.op === "added") {
        adds.push({ e: op.e, a: op.a, v: op.v });
      } else {
        retracts.push({ e: op.e, a: op.a, v: op.v });
      }
    }

    // Validate transaction data
    // Apply retracts first, then adds, so validation can see retracted values
    if (retracts.length > 0) {
      await this.validateDatoms(retracts, false);
    }
    if (adds.length > 0) {
      // Validate adds, but account for retracts in the same transaction
      await this.validateDatoms(adds, true, retracts);
    }

    // Apply retracts first, then adds
    // Note: If both retracts and adds are present, they may get different transaction IDs
    // depending on the implementation. For atomicity, implementations should ensure
    // they use the same transaction ID when called sequentially.
    let txId: TransactionId;
    if (retracts.length > 0) {
      txId = await this.retractDatoms(retracts);
    }
    if (adds.length > 0) {
      txId = await this.addDatoms(adds);
    } else if (retracts.length === 0) {
      // If there are no operations, still create a new transaction ID
      // This ensures that even empty transactions get a unique ID (useful for metadata tracking)
      txId = await this.addDatoms([]);
    } else {
      // txId was set by retractDatoms above
      txId = txId!;
    }

    // Store metadata if provided (implementations can override onTransactionMetadata)
    if (metadata !== undefined) {
      await this.onTransactionMetadata(txId, metadata);
    }

    return txId;
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
   * Define an attribute schema
   * @param definition Attribute definition
   * @example
   * // Basic attribute definition
   * await db.defineAttribute({
   *   name: "email",
   *   type: "string",
   *   unique: true,
   *   cardinality: "one"
   * });
   *
   * // Attribute with type constraint
   * await db.defineAttribute({
   *   name: "age",
   *   type: "number",
   *   cardinality: "one"
   * });
   *
   * // Reference attribute (EntityId)
   * await db.defineAttribute({
   *   name: "parent",
   *   type: "ref",
   *   cardinality: "one"
   * });
   */
  async defineAttribute(definition: AttributeDefinition): Promise<void> {
    await this.ensureInitialized();
    this.schema.set(definition.name, definition);
    await this.onAttributeDefined(definition);
  }

  /**
   * Hook for implementations to handle attribute definition
   * (e.g., create indexes)
   * @example
   * // override in your subclass to handle new attribute definitions
   * protected async onAttributeDefined(definition: AttributeDefinition) { ... }
   */
  protected async onAttributeDefined(
    _definition: AttributeDefinition
  ): Promise<void> {
    // Override in implementations if needed
  }

  /**
   * Get attribute definition for a given attribute name
   * @param name Attribute name
   * @returns Attribute definition or undefined
   * @example
   * const def = db.getAttributeDefinition("tag");
   */
  getAttributeDefinition(name: string): AttributeDefinition | undefined {
    return this.schema.get(name);
  }

  /**
   * Modify an existing attribute definition
   * @param name Attribute name
   * @param updates Partial attribute definition with fields to update
   * @example
   * // Change cardinality from "one" to "many"
   * await db.modifyAttribute("tag", { cardinality: "many" });
   *
   * // Add uniqueness constraint
   * await db.modifyAttribute("email", { unique: true });
   */
  async modifyAttribute(
    name: string,
    updates: Partial<Omit<AttributeDefinition, "name">>
  ): Promise<void> {
    await this.ensureInitialized();
    const existing = this.schema.get(name);
    if (!existing) {
      throw new Error(`Attribute "${name}" is not defined`);
    }
    const updated: AttributeDefinition = { ...existing, ...updates };

    // Validate existing data against new constraints
    await this.validateAttributeModification(name, existing, updated);

    this.schema.set(name, updated);
    await this.onAttributeModified(name, existing, updated);
  }

  /**
   * Validate that existing data complies with new attribute constraints.
   * Called before modifying an attribute definition to ensure data integrity.
   * @param name Attribute name
   * @param oldDefinition Previous attribute definition
   * @param newDefinition Updated attribute definition
   * @throws Error if existing data violates new constraints
   * @example
   * // Validates uniqueness, cardinality changes, etc.
   */
  protected async validateAttributeModification(
    name: string,
    oldDefinition: AttributeDefinition,
    newDefinition: AttributeDefinition
  ): Promise<void> {
    // Check if uniqueness constraint is being added
    if (!oldDefinition.unique && newDefinition.unique) {
      // Find all datoms with this attribute
      const allDatoms = await this.queryInternal({ a: name });
      // Group by value to check for duplicates
      const valueToEntities = new Map<string, EntityId[]>();
      for (const datom of allDatoms) {
        const valueKey = JSON.stringify(datom.v);
        if (!valueToEntities.has(valueKey)) {
          valueToEntities.set(valueKey, []);
        }
        valueToEntities.get(valueKey)!.push(datom.e);
      }
      // Check for duplicate values across different entities
      for (const [valueKey, entities] of valueToEntities) {
        const uniqueEntities = new Set(entities.map((e) => String(e)));
        if (uniqueEntities.size > 1) {
          const value: unknown = JSON.parse(valueKey);
          throw new Error(
            `Cannot add uniqueness constraint to attribute "${name}": duplicate value ${JSON.stringify(
              value
            )} exists for entities ${Array.from(uniqueEntities).join(", ")}`
          );
        }
      }
    }

    // Check if cardinality is being changed from "many" to "one"
    if (
      oldDefinition.cardinality === "many" &&
      newDefinition.cardinality === "one"
    ) {
      // Find all entities with multiple values for this attribute
      const allDatoms = await this.queryInternal({ a: name });
      const entityToValues = new Map<string, Set<string>>();
      for (const datom of allDatoms) {
        const entityKey = String(datom.e);
        if (!entityToValues.has(entityKey)) {
          entityToValues.set(entityKey, new Set());
        }
        entityToValues.get(entityKey)!.add(JSON.stringify(datom.v));
      }
      // Check for entities with multiple values
      const violations: string[] = [];
      for (const [entityKey, values] of entityToValues) {
        if (values.size > 1) {
          violations.push(entityKey);
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `Cannot change cardinality from "many" to "one" for attribute "${name}": entities ${violations.join(
            ", "
          )} have multiple values. Retract duplicate values first.`
        );
      }
    }

    // Check if type constraint is being added or made more restrictive
    if (
      newDefinition.type !== undefined &&
      newDefinition.type !== null &&
      (oldDefinition.type === undefined ||
        oldDefinition.type === null ||
        oldDefinition.type !== newDefinition.type)
    ) {
      // Validate all existing values match the new type
      const allDatoms = await this.queryInternal({ a: name });
      for (const datom of allDatoms) {
        const typeError = this.validateValueType(
          datom.v,
          newDefinition.type!,
          name
        );
        if (typeError) {
          throw new Error(
            `Cannot change type constraint for attribute "${name}": existing value ${JSON.stringify(
              datom.v
            )} for entity "${String(datom.e)}" does not match new type "${newDefinition.type
            }". ${typeError.message}`
          );
        }
      }
    }
  }

  /**
   * Hook for implementations to handle attribute modification
   * (e.g., update indexes, validate existing data)
   * @param name Attribute name
   * @param oldDefinition Previous attribute definition
   * @param newDefinition Updated attribute definition
   * @example
   * // Override in your subclass to handle attribute modifications
   * protected async onAttributeModified(
   *   name: string,
   *   oldDefinition: AttributeDefinition,
   *   newDefinition: AttributeDefinition
   * ) { ... }
   */
  protected async onAttributeModified(
    _name: string,
    _oldDefinition: AttributeDefinition,
    _newDefinition: AttributeDefinition
  ): Promise<void> {
    // Override in implementations if needed
  }

  /**
   * Remove an attribute definition from the schema
   * Note: This does not remove existing datoms, only the schema definition
   * @param name Attribute name
   * @example
   * await db.removeAttribute("deprecated-field");
   */
  async removeAttribute(name: string): Promise<void> {
    await this.ensureInitialized();
    const existing = this.schema.get(name);
    if (!existing) {
      throw new Error(`Attribute "${name}" is not defined`);
    }
    this.schema.delete(name);
    await this.onAttributeRemoved(name, existing);
  }

  /**
   * Hook for implementations to handle attribute removal
   * (e.g., drop indexes)
   * @param name Attribute name
   * @param definition The removed attribute definition
   * @example
   * // Override in your subclass to handle attribute removal
   * protected async onAttributeRemoved(
   *   name: string,
   *   definition: AttributeDefinition
   * ) { ... }
   */
  protected async onAttributeRemoved(
    _name: string,
    _definition: AttributeDefinition
  ): Promise<void> {
    // Override in implementations if needed
  }

  /**
   * Export the current schema as a versioned schema export
   * Useful for migrations, backups, or schema versioning
   * @returns Versioned schema export with metadata
   * @example
   * const schema = db.exportSchema();
   * // Save to file or version control
   * await fs.writeFile("schema.json", JSON.stringify(schema, null, 2));
   * // Schema includes: version, schemaVersion, exportedAt, and attributes
   */
  async exportSchema(): Promise<SchemaExport> {
    await this.ensureInitialized();
    const schemaVersion = await this.getSchemaVersion();
    return {
      version: 1, // Schema format version
      schemaVersion,
      exportedAt: new Date().toISOString(),
      attributes: Array.from(this.schema.values()),
    };
  }

  /**
   * Import a schema from a versioned schema export or legacy array format
   * Useful for migrations or restoring schema from backup
   *
   * **Backward Compatibility:** Accepts both SchemaExport objects and legacy AttributeDefinition[] arrays
   *
   * **Schema Evolution:** When importing a versioned schema, validates format version compatibility.
   * Implementations can override `onSchemaVersionChange()` to handle version changes.
   *
   * @param input SchemaExport object or legacy AttributeDefinition[] array
   * @example
   * // Import versioned schema
   * const schema = JSON.parse(await fs.readFile("schema.json", "utf-8"));
   * await db.importSchema(schema); // SchemaExport object
   *
   * // Import legacy format (backward compatible)
   * const legacySchema = JSON.parse(await fs.readFile("old-schema.json", "utf-8"));
   * await db.importSchema(legacySchema); // AttributeDefinition[] array
   */
  async importSchema(
    input: SchemaExport | AttributeDefinition[]
  ): Promise<void> {
    await this.ensureInitialized();

    // Handle legacy format (backward compatibility)
    if (Array.isArray(input)) {
      // Legacy format: just an array of attribute definitions
      this.schema.clear();
      for (const definition of input) {
        await this.defineAttribute(definition);
      }
      return;
    }

    // Versioned schema format
    const schemaExport = input as SchemaExport;

    // Validate format version (currently only version 1 is supported)
    if (schemaExport.version !== 1) {
      throw new Error(
        `Unsupported schema format version: ${schemaExport.version}. Expected version 1.`
      );
    }

    // Check if schema version is changing
    const currentSchemaVersion = await this.getSchemaVersion();
    const versionChanging = schemaExport.schemaVersion !== currentSchemaVersion;

    if (versionChanging) {
      await this.onSchemaVersionChange(
        currentSchemaVersion,
        schemaExport.schemaVersion
      );
    }

    // Clear existing schema
    this.schema.clear();

    // Import each definition
    for (const definition of schemaExport.attributes) {
      await this.defineAttribute(definition);
    }

    // Update schema version if different
    if (versionChanging) {
      await this.migrate(schemaExport.schemaVersion);
    }
  }

  /**
   * Hook for implementations to handle schema version changes during import
   * Called when importing a schema with a different schemaVersion than the current one
   * @param oldVersion Current schema version
   * @param newVersion New schema version from import
   * @example
   * // Override in your subclass to handle schema version changes:
   * protected async onSchemaVersionChange(
   *   oldVersion: number,
   *   newVersion: number
   * ): Promise<void> {
   *   // Perform any necessary migration logic
   *   console.log(`Schema version changing from ${oldVersion} to ${newVersion}`);
   * }
   */
  protected async onSchemaVersionChange(
    _oldVersion: number,
    _newVersion: number
  ): Promise<void> {
    // Override in implementations if needed
    // Default: no-op (schema version change is handled by migrate())
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
    // to provide undeduplicated results. For now, we'll use executeQuery with added: undefined
    // to get all datoms including retracted ones, then the view will handle deduplication.
    return this.executeQuery({
      ...options,
      added: undefined, // Get all datoms including retracted
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

    // Filter out retracted datoms (keep only added: true)
    return Array.from(deduplicated.values()).filter((d) => d.added);
  }

  /**
   * Execute a history query - returns all datoms including retracted, without deduplication.
   * This method is called by HistoryDatabaseView to leverage database-native query optimization.
   * @param options Query options
   * @returns Array of all matching datoms (including retracted)
   * @internal
   */
  public async executeHistoryQuery(options: QueryOptions): Promise<Datom[]> {
    // Default implementation: use getRawDatoms
    // SQL implementations should override this for better performance
    return this.getRawDatoms({
      ...options,
      added: undefined, // Don't filter by added/retracted
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

    // Filter out retracted datoms (keep only added: true)
    return Array.from(deduplicated.values()).filter((d) => d.added);
  }

  /**
   * Validate datoms against the current schema.
   *
   * **Implementation Note:** This method should be called in `add()` and `retract()`
   * implementations before writing datoms to the database. It validates:
   * - Type constraints (if `type` is specified in the attribute definition)
   * - Cardinality constraints (for `cardinality: "one"` attributes)
   * - Uniqueness constraints (for `unique: true` attributes)
   *
   * Transaction implementations may optionally call this method on commit to validate
   * all pending changes at once, or they may defer validation to the base class methods.
   *
   * @param datoms Array of datoms to validate
   * @param isAdd Whether these datoms are being added (true) or retracted (false)
   * @throws Error if validation fails (type mismatch, cardinality violation, uniqueness violation)
   * @example
   * // Typical usage in add() implementation:
   * async add(datoms: DatomInput[]): Promise<TransactionId> {
   *   await this.ensureInitialized();
   *   await this.validateDatoms(datoms, true);
   *   // ... proceed with adding datoms
   * }
   */
  protected async validateDatoms(
    datoms: DatomInput[],
    isAdd: boolean,
    retractsInSameTransaction?: DatomInput[]
  ): Promise<void> {
    if (datoms.length === 0) {
      return;
    }

    // Group datoms by attribute for efficient validation
    const byAttribute = new Map<string, DatomInput[]>();
    for (const datom of datoms) {
      const attrKey = String(datom.a);
      if (!byAttribute.has(attrKey)) {
        byAttribute.set(attrKey, []);
      }
      byAttribute.get(attrKey)!.push(datom);
    }

    // Validate each attribute group
    for (const [attrKey, attrDatoms] of byAttribute) {
      const definition = this.getAttributeDefinition(attrKey);
      if (!definition) {
        // If no schema is defined, we allow any attribute but can't validate constraints
        continue;
      }

      // Type validation (only for adds)
      if (isAdd && definition.type !== undefined && definition.type !== null) {
        for (const datom of attrDatoms) {
          const { a: attribute, v: value } = datom;
          const typeError = this.validateValueType(
            value,
            definition.type,
            attribute
          );
          if (typeError) {
            throw new DatomTypeError(
              String(attribute),
              value,
              definition.type!,
              typeof value
            );
          }
        }
      }

      // Batch cardinality checks: group by (entity, attribute)
      if (isAdd && definition.cardinality === "one") {
        const entityAttributePairs = new Map<string, DatomInput>();
        for (const datom of attrDatoms) {
          const key = `${String(datom.e)}|${String(datom.a)}`;
          if (entityAttributePairs.has(key)) {
            // Multiple values for same entity-attribute pair in this batch
            throw new CardinalityError(
              String(datom.a),
              String(datom.e),
              "multiple_values_in_batch"
            );
          }
          entityAttributePairs.set(key, datom);
        }

        // Batch query for existing values
        for (const datom of entityAttributePairs.values()) {
          // Use the original datom entity/attribute instead of splitting the key
          // to preserve the original types (number vs string)
          const entity = datom.e;
          const attribute = datom.a;
          const newValue = datom.v;

          // Check if this value is being retracted in the same transaction
          const isBeingRetracted = retractsInSameTransaction?.some(
            (r) =>
              r.e === entity &&
              String(r.a) === String(attribute) &&
              JSON.stringify(r.v) === JSON.stringify(newValue)
          );

          // If being retracted, skip validation (it's a replace operation)
          if (isBeingRetracted) {
            continue;
          }

          const existingDatoms = await this.queryInternal({
            e: entity,
            a: String(attribute),
          });
          if (existingDatoms.length > 0) {
            // If the existing value is the same as what we're trying to add, allow it (idempotent)
            // This is useful for imports where the same datom might appear multiple times
            const existingValue = existingDatoms[0].v;
            if (JSON.stringify(existingValue) !== JSON.stringify(newValue)) {
              // Check if the existing value is being retracted
              const existingIsBeingRetracted = retractsInSameTransaction?.some(
                (r) =>
                  r.e === entity &&
                  String(r.a) === String(attribute) &&
                  JSON.stringify(r.v) === JSON.stringify(existingValue)
              );

              if (!existingIsBeingRetracted) {
                throw new CardinalityError(
                  String(attribute),
                  String(entity),
                  "existing_value_conflict"
                );
              }
            }
          }
        }
      }

      // Batch uniqueness checks: group by (attribute, value)
      if (isAdd && definition.unique) {
        const valueGroups = new Map<string, DatomInput[]>();
        for (const datom of attrDatoms) {
          const valueKey = JSON.stringify(datom.v);
          if (!valueGroups.has(valueKey)) {
            valueGroups.set(valueKey, []);
          }
          valueGroups.get(valueKey)!.push(datom);
        }

        // Batch query for existing datoms with same attribute-value
        for (const [valueKey, valueDatoms] of valueGroups) {
          const value = JSON.parse(valueKey) as Value;
          const existingDatoms = await this.datoms({
            a: attrKey,
            v: value,
          });

          if (existingDatoms.length > 0) {
            const existingEntity = existingDatoms[0]?.e;
            // Check if any of the new datoms have a different entity
            for (const datom of valueDatoms) {
              if (
                existingEntity !== undefined &&
                String(datom.e) !== String(existingEntity)
              ) {
                throw new UniqueConstraintError(attrKey, value, existingEntity);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Validate that a value matches the expected type for an attribute
   * @param value The value to validate
   * @param expectedType The expected type from the attribute definition
   * @param attribute The attribute name (for error messages)
   * @returns Error if type mismatch, undefined if valid
   * @internal
   */
  private validateValueType(
    value: Value,
    expectedType: "string" | "number" | "boolean" | "date" | "ref",
    attribute: Attribute
  ): Error | undefined {
    switch (expectedType) {
      case "string":
        if (typeof value !== "string") {
          return new Error(
            `Attribute "${String(
              attribute
            )}" expects type "string", but got ${typeof value}`
          );
        }
        break;
      case "number":
        if (typeof value !== "number") {
          return new Error(
            `Attribute "${String(
              attribute
            )}" expects type "number", but got ${typeof value}`
          );
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return new Error(
            `Attribute "${String(
              attribute
            )}" expects type "boolean", but got ${typeof value}`
          );
        }
        break;
      case "date":
        if (!(value instanceof Date) && typeof value !== "string") {
          return new Error(
            `Attribute "${String(
              attribute
            )}" expects type "date" (Date object or date string), but got ${typeof value}`
          );
        }
        // If it's a string, try to parse it as a date
        if (typeof value === "string") {
          const parsed = new Date(value);
          if (isNaN(parsed.getTime())) {
            return new Error(
              `Attribute "${String(
                attribute
              )}" expects type "date", but string "${value}" is not a valid date`
            );
          }
        }
        break;
      case "ref":
        // EntityId can be number or string
        if (typeof value !== "number" && typeof value !== "string") {
          return new Error(
            `Attribute "${String(
              attribute
            )}" expects type "ref" (EntityId: number | string), but got ${typeof value}`
          );
        }
        break;
    }
    return undefined;
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
   * @returns Query results as an array of records with keys that have the question mark prefix stripped
   * @example
   * const result = await db.query({ find: ["?e"], where: [["?e", "name", "Alice"]] });
   * // result will be [{"e": 123}] not [{"?e": 123}]
   */
  abstract query(query: DatalogQuery): Promise<QueryResult>;

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
   * Create a database view showing full history (all datoms, including retracted)
   * Returns a read-only view that includes all historical changes without deduplication
   * @returns Read-only database view showing full history
   * @example
   * const dbHistory = db.history();
   * const allChanges = await dbHistory.datoms({ entity: 42 });
   * // Includes both added and retracted datoms
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
   *   { op: "added", e: 1, a: "name", v: "Alice" },
   *   { op: "retracted", e: 1, a: "oldName", v: "Bob" }
   * ]);
   *
   * // Query the speculative state
   * const datoms = await result.dbAfter.datoms({ entity: 1 });
   * // Preview what would change
   * console.log(result.txData);
   *
   * // To actually commit, use transact()
   * await db.transact([{ op: "added", e: 1, a: "name", v: "Alice" }]);
   */
  async with(ops: TransactOperations): Promise<WithResult> {
    await this.ensureInitialized();

    // Separate added and retracted operations
    const adds: DatomInput[] = [];
    const retracts: DatomInput[] = [];

    for (const op of ops) {
      if (op.op === "added") {
        adds.push({ e: op.e, a: op.a, v: op.v });
      } else {
        retracts.push({ e: op.e, a: op.a, v: op.v });
      }
    }

    // Validate transaction data
    if (retracts.length > 0) {
      await this.validateDatoms(retracts, false);
    }
    if (adds.length > 0) {
      await this.validateDatoms(adds, true, retracts);
    }

    // Get the next transaction ID for speculative datoms
    const speculativeTxId = (await this.getLatestTransaction()) + 1;

    // Create speculative datoms
    const speculativeAdds: Datom[] = [];
    const speculativeRetracts: Datom[] = [];

    for (const datom of retracts) {
      speculativeRetracts.push({
        e: datom.e,
        a: datom.a,
        v: datom.v,
        tx: speculativeTxId,
        added: false,
      });
    }

    for (const datom of adds) {
      speculativeAdds.push({
        e: datom.e,
        a: datom.a,
        v: datom.v,
        tx: speculativeTxId,
        added: true,
      });
    }

    // Create dbBefore view (current state)
    const dbBefore = new CurrentDatabaseView(this);

    // Create dbAfter view (speculative state)
    const dbAfter = new SpeculativeDatabaseView(
      this,
      speculativeAdds,
      speculativeRetracts
    );

    // Generate txData (all datoms that would be applied)
    const txData: Datom[] = [...speculativeRetracts, ...speculativeAdds];

    return {
      dbBefore,
      dbAfter,
      txData,
      tempIds: {}, // Empty for now, reserved for future tempid support
    };
  }

  /**
   * Get the current schema version
   * @returns The current schema version number
   * @example
   * const version = await db.getSchemaVersion();
   * if (version < 2) {
   *   await db.migrate(2);
   * }
   */
  async getSchemaVersion(): Promise<number> {
    await this.ensureInitialized();
    return this.schemaVersion;
  }

  /**
   * Register a migration
   * @param migration Migration to register
   * @example
   * db.registerMigration({
   *   version: 1,
   *   name: "add_user_table",
   *   up: async (db) => {
   *     await db.defineAttribute({ name: "email", type: "string", cardinality: "one" });
   *   },
   *   down: async (db) => {
   *     await db.removeAttribute("email");
   *   }
   * });
   */
  registerMigration(migration: Migration): void {
    this.migrationRegistry.register(migration);
  }

  /**
   * Register multiple migrations
   * @param migrations Array of migrations to register
   */
  registerMigrations(migrations: Migration[]): void {
    this.migrationRegistry.registerAll(migrations);
  }

  /**
   * Get migration state for a specific version
   * Implementations should override this to persist migration state
   * @param version Migration version
   * @returns Migration state or undefined if not applied
   */
  protected async getMigrationState(
    _version: number
  ): Promise<MigrationState | undefined> {
    // Default: no migration state tracking
    // Implementations should override to persist state
    return undefined;
  }

  /**
   * Save migration state after applying a migration
   * Implementations should override this to persist migration state
   * @param state Migration state to save
   */
  protected async saveMigrationState(_state: MigrationState): Promise<void> {
    // Default: no migration state tracking
    // Implementations should override to persist state
  }

  /**
   * Update migration state after rollback
   * Implementations should override this to persist migration state
   * @param version Migration version to mark as rolled back
   */
  protected async markMigrationRolledBack(_version: number): Promise<void> {
    // Default: no migration state tracking
    // Implementations should override to persist state
  }

  /**
   * Migrate to a specific version using registered migrations
   * Executes all pending migrations up to the target version
   * @param targetVersion Target schema version to migrate to
   * @throws MigrationError if migration fails
   * @example
   * await db.registerMigration({
   *   version: 1,
   *   name: "add_email",
   *   up: async (db) => { await db.defineAttribute({ name: "email", type: "string", cardinality: "one" }); },
   *   down: async (db) => { await db.removeAttribute("email"); }
   * });
   * await db.migrateTo(1);
   */
  async migrateTo(targetVersion: number): Promise<void> {
    await this.ensureInitialized();

    const currentVersion = await this.getSchemaVersion();

    if (targetVersion < currentVersion) {
      throw new MigrationError(
        `Cannot migrate backwards from version ${currentVersion} to ${targetVersion}. Use rollbackTo() instead.`,
        targetVersion
      );
    }

    if (targetVersion === currentVersion) {
      return; // Already at target version
    }

    // Get pending migrations
    const appliedVersions = new Set<number>();

    // TODO: Load applied migrations from database (implementations should override getMigrationState)
    const pendingMigrations = this.migrationRegistry
      .getRange(currentVersion + 1, targetVersion)
      .filter((m) => !appliedVersions.has(m.version));

    if (pendingMigrations.length === 0) {
      // No migrations to apply, but update schema version
      await this.migrate(targetVersion);
      return;
    }

    // Execute migrations in order
    for (const migration of pendingMigrations) {
      try {
        await migration.up(this);

        // Save migration state
        await this.saveMigrationState({
          version: migration.version,
          name: migration.name,
          appliedAt: new Date().toISOString(),
          rolledBack: false,
        });

        // Update schema version
        await this.migrate(migration.version);
      } catch (error) {
        const migrationError = new MigrationError(
          `Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)
          }`,
          migration.version,
          error instanceof Error ? error : undefined
        );

        throw migrationError;
      }
    }
  }

  /**
   * Rollback to a specific version using registered migrations
   * Executes down migrations in reverse order from current version to target version
   * @param targetVersion Target schema version to rollback to
   * @throws MigrationRollbackError if rollback fails
   * @example
   * await db.rollbackTo(0); // Rollback all migrations
   */
  async rollbackTo(targetVersion: number): Promise<void> {
    await this.ensureInitialized();

    const currentVersion = await this.getSchemaVersion();

    if (targetVersion > currentVersion) {
      throw new MigrationRollbackError(
        `Cannot rollback forward from version ${currentVersion} to ${targetVersion}. Use migrateTo() instead.`,
        targetVersion
      );
    }

    if (targetVersion === currentVersion) {
      return; // Already at target version
    }

    // Get migrations to rollback (in reverse order)
    const migrationsToRollback = this.migrationRegistry
      .getRange(targetVersion + 1, currentVersion)
      .reverse();

    if (migrationsToRollback.length === 0) {
      // No migrations to rollback, but update schema version
      await this.migrate(targetVersion);
      return;
    }

    // Execute down migrations in reverse order
    for (const migration of migrationsToRollback) {
      try {
        await migration.down(this);

        // Mark migration as rolled back
        await this.markMigrationRolledBack(migration.version);

        // Update schema version directly (rollback doesn't go through migrate())
        // This avoids the backward migration check in migrate()
        this.schemaVersion = migration.version - 1;
      } catch (error) {
        const rollbackError = new MigrationRollbackError(
          `Rollback of migration ${migration.version} (${migration.name
          }) failed: ${error instanceof Error ? error.message : String(error)}`,
          migration.version,
          error instanceof Error ? error : undefined
        );

        throw rollbackError;
      }
    }
  }

  /**
   * Migrate the database schema to a specific version
   * Implementations should override this method to perform actual migrations.
   * The base implementation only updates the schema version counter.
   * @param targetVersion Target schema version to migrate to
   * @throws MigrationError if migration fails
   * @example
   * // In your implementation:
   * async migrate(version: number): Promise<void> {
   *   await super.migrate(version);
   *   const current = await this.getSchemaVersion();
   *   for (let v = current + 1; v <= version; v++) {
   *     await this.runMigration(v);
   *   }
   * }
   */
  async migrate(targetVersion: number): Promise<void> {
    await this.ensureInitialized();
    try {
      if (targetVersion < this.schemaVersion) {
        throw new MigrationError(
          `Cannot migrate backwards from version ${this.schemaVersion} to ${targetVersion}`,
          targetVersion
        );
      }

      await this.onMigrate(this.schemaVersion, targetVersion);
      this.schemaVersion = targetVersion;
    } catch (error) {
      // If error is already a MigrationError, rethrow
      if (error instanceof MigrationError) {
        throw error;
      }
      // For other errors during onMigrate, wrap in MigrationError
      throw new MigrationError(
        `Migration to version ${targetVersion} failed: ${error instanceof Error ? error.message : String(error)
        }`,
        targetVersion,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Hook for implementations to perform actual migration logic
   * @param fromVersion Current schema version
   * @param toVersion Target schema version
   * @example
   * protected async onMigrate(fromVersion: number, toVersion: number): Promise<void> {
   *   // Perform migration steps
   * }
   */
  protected async onMigrate(
    _fromVersion: number,
    _toVersion: number
  ): Promise<void> {
    // Override in implementations to perform actual migrations
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
