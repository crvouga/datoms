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
  DatabaseEvent,
  DatabaseEventListener,
  DatabaseHealth,
  DatabaseStats,
  EntityId,
  Logger,
  QueryExplainResult,
  QueryOptions,
  SchemaExport,
  TransactionId,
  TransactionOptions,
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
  TransactionConflictError,
  UniqueConstraintError,
} from "./errors.js";
import type { Migration, MigrationState } from "../types.js";
import { MigrationRegistry } from "./migrations/migration-registry.js";

/**
 * Shared interface for reading datoms
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
   * // Time-travel query: query database state at a specific transaction ID
   * const atOldTx = await db.datoms({ asOf: 87, entity: 42 });
   */
  datoms(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query
   * @param query Datalog query to execute
   * @returns Query results as an array of records
   * @example
   * const results = await db.query(["find", "?e", "where", ["?e", "name", "alice"]]);
   * //=> [{"e": 1}, {"e": 2}]
   */
  query(query: DatalogQuery): Promise<QueryResult>;

  /**
   * Get a single value for an entity-attribute pair
   *
   * **Cardinality behavior:**
   * - For `cardinality: "one"` attributes: Returns the single value
   * - For `cardinality: "many"` attributes: Returns the value with the highest transaction ID (most recent)
   *
   * **Note:** For multi-valued attributes, consider using `getLatestValue()` for clarity,
   * or `getValues()` to get all values.
   *
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found. For multi-valued attributes, returns the most recent value.
   * @example
   * const name = await db.getValue(42, "name"); // e.g. "Alice"
   * // For multi-valued attributes, returns the latest value
   * const latestTag = await db.getValue(42, "tag"); // Returns most recent tag
   */
  getValue(entity: EntityId, attribute: string): Promise<Value | undefined>;

  /**
   * Get the most recent value for an entity-attribute pair
   * Explicitly returns the value with the highest transaction ID (most recent).
   * This is equivalent to `getValue()` but makes the intent clearer for multi-valued attributes.
   *
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The most recent value or undefined if not found
   * @example
   * // Get the latest tag added to an entity
   * const latestTag = await db.getLatestValue(42, "tag");
   */
  getLatestValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined>;

  /**
   * Get all values for an entity-attribute pair
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns Array of values
   * @example
   * const tags = await db.getValues(123, "tag"); // e.g. ["red", "big"]
   */
  getValues(entity: EntityId, attribute: string): Promise<Value[]>;

  /**
   * Check if a fact exists
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param value Value to check
   * @returns True if the fact exists
   * @example
   * if (await db.hasFact(42, "name", "Alice")) { ... }
   */
  hasFact(entity: EntityId, attribute: string, value: Value): Promise<boolean>;

  /**
   * Batch get values for multiple entity-attribute pairs
   * @param queries Array of {entity, attribute} pairs to query
   * @returns Array of values in the same order as queries (undefined if not found)
   * @example
   * const values = await db.getValuesBatch([
   *   { entity: 1, attribute: "name" },
   *   { entity: 2, attribute: "age" },
   *   { entity: 1, attribute: "email" }
   * ]);
   * // Returns: ["Alice", 30, "alice@example.com"]
   */
  getValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<(Value | undefined)[]>;

  /**
   * Batch get all values for multiple entity-attribute pairs (for multi-valued attributes)
   * @param queries Array of {entity, attribute} pairs to query
   * @returns Array of value arrays in the same order as queries
   * @example
   * const allValues = await db.getAllValuesBatch([
   *   { entity: 1, attribute: "tag" },
   *   { entity: 2, attribute: "tag" }
   * ]);
   * // Returns: [["red", "big"], ["blue"]]
   */
  getAllValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<Value[][]>;

  /**
   * Find all entities that have a specific attribute-value pair
   * @param attribute Attribute name
   * @param value Value to search for
   * @returns Array of entity IDs that have this attribute-value pair
   * @example
   * const users = await db.findEntities("status", "active");
   * // Returns: [1, 5, 42]
   */
  findEntities(attribute: string, value: Value): Promise<EntityId[]>;

  /**
   * Explain a query to get optimization hints and execution plan
   * @param options Query options to explain
   * @returns Query explanation result with optimization hints
   * @example
   * const explanation = await db.explainQuery({ attribute: "name", value: "Alice" });
   * console.log(`Estimated rows: ${explanation.estimatedRows}`);
   */
  explainQuery(options: QueryOptions): Promise<QueryExplainResult>;
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
 * Shared interface for writing datoms
 */
export interface DatomWriter<T = void> {
  /**
   * Add datoms to the database
   * @param datoms Array of datoms to add
   * @returns The transaction ID (T)
   * @example
   * await db.add([
   *   [100, "name", "Alice"],
   *   [100, "age", 34]
   * ]);
   */
  add(datoms: DatomInput[]): Promise<T>;

  /**
   * Retract datoms from the database
   * @param datoms Array of datoms to retract
   * @returns The transaction ID (T)
   * @example
   * await db.retract([[100, "age", 34]]);
   */
  retract(datoms: DatomInput[]): Promise<T>;

  /**
   * Retract all datoms for a specific entity
   * @param entity Entity ID
   * @returns The transaction ID (T)
   * @example
   * await db.retractEntity(1234);
   */
  retractEntity(entity: EntityId): Promise<T>;

  /**
   * Retract all values for a specific entity-attribute pair
   * Useful for clearing all values of a multi-valued attribute or resetting a single-valued attribute
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The transaction ID (T)
   * @example
   * // Clear all tags for an entity
   * await db.retractAttribute(123, "tag");
   *
   * // Reset a single-valued attribute
   * await db.retractAttribute(123, "status");
   */
  retractAttribute(entity: EntityId, attribute: string): Promise<T>;

  /**
   * Upsert a value for an entity-attribute pair
   * For `cardinality: "one"` attributes, this retracts any existing value and adds the new value atomically.
   * For `cardinality: "many"` attributes, this simply adds the value (no retraction).
   *
   * **Note:** Requires `cardinality: "one"` in schema to retract old values, otherwise just adds.
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param value Value to upsert
   * @returns The transaction ID (T)
   * @example
   * // Upsert a single-valued attribute (retracts old value, adds new)
   * await db.upsert(123, "status", "active");
   */
  upsert(entity: EntityId, attribute: string, value: Value): Promise<T>;

  /**
   * Execute bulk operations atomically
   * @param ops Object containing add and/or retract arrays
   * @param metadata Optional metadata to associate with this transaction
   * @returns The transaction ID (T)
   * @example
   * await db.transact({
   *   add: [[200, "name", "Carol"]],
   *   retract: [[100, "name", "Alice"]]
   * });
   *
   * // With metadata
   * await db.transact(
   *   { add: [[200, "name", "Carol"]] },
   *   { userId: "alice", reason: "update" }
   * );
   */
  transact(
    ops: { add?: DatomInput[]; retract?: DatomInput[] },
    metadata?: Record<string, unknown>
  ): Promise<T>;
}

/**
 * Transaction interface that exposes all database operations
 * scoped to a transaction. Queries within a transaction see
 * uncommitted changes from earlier operations in the same transaction.
 *
 * **Transaction ID Behavior:**
 * - The transaction ID is assigned when the transaction begins, before any operations
 * - `getTransactionId()` returns the ID that will be used when the transaction commits
 * - For SQL backends, the ID is generated from a sequence/counter before commit
 * - For in-memory backends, the ID is assigned immediately
 * - The ID is stable throughout the transaction lifecycle
 *
 * @example
 * await db.transaction(async (tx) => {
 *   await tx.add([[123, "score", 10]]);
 *   // all reads see the new datom, but not yet committed to the main db
 *   const current = await tx.getValue(123, "score");
 *   const txid = tx.getTransactionId(); // Returns the ID that will be used on commit
 * });
 */
export interface Transaction extends DatomReader, DatomWriter<void> {
  /**
   * Get the transaction ID for the current transaction.
   * The transaction ID is assigned when the transaction begins and remains stable
   * throughout the transaction. It will be the ID used when the transaction commits.
   *
   * **Implementation Note:** All implementations assign transaction IDs before commit,
   * so this method works reliably across all backends (in-memory, SQLite, PostgreSQL).
   *
   * @returns The transaction ID that will be used when this transaction commits
   * @example
   * await db.transaction(async (tx) => {
   *   await tx.add([[1, "name", "Test"]]);
   *   const txid = tx.getTransactionId(); // e.g., 42
   *   // This ID will be used when the transaction commits
   * });
   */
  getTransactionId(): TransactionId;
}

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
 * - Use `explainQuery()` for optimization hints
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
export abstract class DatomDatabase
  implements DatomReader, DatomWriter<TransactionId>
{
  protected initialized = false;
  protected schema: Map<string, AttributeDefinition> = new Map();
  protected schemaVersion: number = 0;
  private eventListeners: Map<
    DatabaseEvent["type"],
    Set<DatabaseEventListener>
  > = new Map();
  /** Optional logger for structured logging (compatible with Pino, Winston, etc.) */
  protected logger?: Logger;
  /** Migration registry for managing migrations */
  protected migrationRegistry: MigrationRegistry = new MigrationRegistry();
  /**
   * Concurrency limit for batch queries (default: 50)
   * Override this property in subclasses to tune batch query performance
   * @example
   * // In your subclass constructor:
   * this.batchQueryConcurrencyLimit = 100; // Increase for high-performance scenarios
   */
  protected batchQueryConcurrencyLimit: number = 50;

  /**
   * Set an optional logger for structured logging
   * Compatible with common logging libraries (Pino, Winston, etc.)
   * @param logger Logger instance
   * @example
   * import pino from "pino";
   * const logger = pino();
   * db.setLogger(logger);
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
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
   * Add datoms to the database
   * Validates datoms before calling the implementation-specific addDatoms method.
   * @param datoms Array of datoms to add
   * @returns The transaction ID
   * @example
   * await db.add([[42, "type", "cat"]]);
   */
  async add(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    await this.validateDatoms(datoms, true);
    return this.addDatoms(datoms);
  }

  /**
   * Implementation-specific method to add datoms after validation.
   * Subclasses should override this method instead of add().
   * @param datoms Array of validated datoms to add
   * @returns The transaction ID
   * @internal
   */
  protected abstract addDatoms(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Retract datoms from the database
   * Validates datoms before calling the implementation-specific retractDatoms method.
   * @param datoms Array of datoms to retract
   * @returns The transaction ID
   * @example
   * await db.retract([[42, "type", "cat"]]);
   */
  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    await this.validateDatoms(datoms, false);
    return this.retractDatoms(datoms);
  }

  /**
   * Implementation-specific method to retract datoms after validation.
   * Subclasses should override this method instead of retract().
   * @param datoms Array of validated datoms to retract
   * @returns The transaction ID
   * @internal
   */
  protected abstract retractDatoms(
    datoms: DatomInput[]
  ): Promise<TransactionId>;

  /**
   * Retract all datoms for a specific entity
   * @param entity Entity ID
   * @returns The transaction ID
   * @example
   * await db.retractEntity(42);
   */
  abstract retractEntity(entity: EntityId): Promise<TransactionId>;

  /**
   * Retract all values for a specific entity-attribute pair
   * Useful for clearing all values of a multi-valued attribute or resetting a single-valued attribute
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The transaction ID
   * @example
   * // Clear all tags for an entity
   * await db.retractAttribute(123, "tag");
   *
   * // Reset a single-valued attribute
   * await db.retractAttribute(123, "status");
   */
  async retractAttribute(
    entity: EntityId,
    attribute: string
  ): Promise<TransactionId> {
    await this.ensureInitialized();
    // Get all current values for this entity-attribute pair
    const datoms = await this.datoms({ entity, attribute });
    if (datoms.length === 0) {
      // No values to retract, but still return a transaction ID for consistency
      return this.transact({});
    }
    // Retract all existing values
    const toRetract: DatomInput[] = datoms.map((d) => [
      d.entity,
      d.attribute,
      d.value,
    ]);
    return this.retract(toRetract);
  }

  /**
   * Execute bulk operations atomically
   * @param ops Object containing add and/or retract arrays
   * @param metadata Optional metadata to associate with this transaction (e.g., {userId: "alice", reason: "bulk_update"})
   * @returns The transaction ID
   * @example
   * await db.transact({
   *   add: [[300, "status", "active"]],
   *   retract: [[42, "type", "cat"]]
   * });
   *
   * // With metadata
   * await db.transact(
   *   { add: [[300, "status", "active"]] },
   *   { userId: "alice", reason: "status_update" }
   * );
   */
  async transact(
    ops: {
      add?: DatomInput[];
      retract?: DatomInput[];
    },
    metadata?: Record<string, unknown>
  ): Promise<TransactionId> {
    const result = await this.transactWithResult(ops, metadata);
    return result.txId;
  }

  /**
   * Upsert a value for an entity-attribute pair
   * For `cardinality: "one"` attributes, this retracts any existing value and adds the new value atomically.
   * For `cardinality: "many"` attributes, this simply adds the value (no retraction).
   *
   * **Behavior:**
   * - If the attribute is defined with `cardinality: "one"`, retracts any existing value and adds the new value
   * - If the attribute is not defined or has `cardinality: "many"`, only adds the value (no retraction)
   * - Works without schema definitions, but requires `cardinality: "one"` in schema to retract old values
   *
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param value Value to upsert
   * @returns The transaction ID
   * @example
   * // Upsert a single-valued attribute (retracts old value, adds new)
   * await db.defineAttribute({ name: "status", cardinality: "one", type: "string" });
   * await db.upsert(123, "status", "active");
   *
   * // For multi-valued attributes, this just adds (use add() directly)
   * await db.upsert(123, "tag", "new-tag"); // Adds without retracting
   */
  async upsert(
    entity: EntityId,
    attribute: string,
    value: Value
  ): Promise<TransactionId> {
    await this.ensureInitialized();
    const definition = this.getAttributeDefinition(attribute);

    // If cardinality is "one", retract existing value first
    if (definition?.cardinality === "one") {
      const existingValues = await this.getValues(entity, attribute);
      const toRetract: DatomInput[] = existingValues.map((v) => [
        entity,
        attribute,
        v,
      ]);
      return this.transact({
        retract: toRetract.length > 0 ? toRetract : undefined,
        add: [[entity, attribute, value]],
      });
    }

    // For "many" or undefined cardinality, just add
    return this.add([[entity, attribute, value]]);
  }

  /**
   * Execute bulk operations atomically and return detailed result
   * @param ops Object containing add and/or retract arrays
   * @param metadata Optional metadata to associate with this transaction
   * @returns Transaction result with counts
   * @example
   * const result = await db.transactWithResult({
   *   add: [[300, "status", "active"]],
   *   retract: [[42, "type", "cat"]]
   * });
   * // Returns: { txId: 123, addedCount: 1, retractedCount: 1 }
   */
  async transactWithResult(
    ops: {
      add?: DatomInput[];
      retract?: DatomInput[];
    },
    metadata?: Record<string, unknown>
  ): Promise<TransactResult> {
    await this.ensureInitialized();
    // Use a transaction to ensure atomicity
    return this.transaction(async (tx) => {
      const addedCount = ops.add?.length ?? 0;
      const retractedCount = ops.retract?.length ?? 0;

      if (ops.add && ops.add.length > 0) {
        await tx.add(ops.add);
      }
      if (ops.retract && ops.retract.length > 0) {
        await tx.retract(ops.retract);
      }
      const txId = tx.getTransactionId();
      // Store metadata if provided (implementations can override onTransactionMetadata)
      if (metadata !== undefined) {
        await this.onTransactionMetadata(txId, metadata);
      }

      const result = {
        txId,
        addedCount,
        retractedCount,
      };

      // Emit transaction event
      await this.emitEvent({
        type: "transaction",
        txId,
        addedCount,
        retractedCount,
        metadata,
      });

      return result;
    });
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
      const allDatoms = await this.queryInternal({ attribute: name });
      // Group by value to check for duplicates
      const valueToEntities = new Map<string, EntityId[]>();
      for (const datom of allDatoms) {
        const valueKey = JSON.stringify(datom.value);
        if (!valueToEntities.has(valueKey)) {
          valueToEntities.set(valueKey, []);
        }
        valueToEntities.get(valueKey)!.push(datom.entity);
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
      const allDatoms = await this.queryInternal({ attribute: name });
      const entityToValues = new Map<string, Set<string>>();
      for (const datom of allDatoms) {
        const entityKey = String(datom.entity);
        if (!entityToValues.has(entityKey)) {
          entityToValues.set(entityKey, new Set());
        }
        entityToValues.get(entityKey)!.add(JSON.stringify(datom.value));
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
      const allDatoms = await this.queryInternal({ attribute: name });
      for (const datom of allDatoms) {
        const typeError = this.validateValueType(
          datom.value,
          newDefinition.type!,
          name
        );
        if (typeError) {
          throw new Error(
            `Cannot change type constraint for attribute "${name}": existing value ${JSON.stringify(
              datom.value
            )} for entity "${String(datom.entity)}" does not match new type "${
              newDefinition.type
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
    const startTime = Date.now();
    try {
      // Validate that query has at least one filter or limit to prevent accidental full scans
      const hasFilter =
        options.entity !== undefined ||
        options.attribute !== undefined ||
        options.value !== undefined ||
        options.tx !== undefined ||
        options.asOf !== undefined;
      const hasLimit = options.limit !== undefined;
      const isHistory = options.history === true;

      if (!hasFilter && !hasLimit) {
        if (isHistory) {
          throw new QuerySafetyError(
            "History query must include at least one filter or a limit to prevent full table scans"
          );
        }
        throw new QuerySafetyError(
          "Query must include at least one filter (entity, attribute, value, tx, asOf) or a limit to prevent full table scans"
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

      const duration = Date.now() - startTime;

      await this.recordQueryMetrics(duration);

      await this.emitEvent({
        type: "query",
        options,
        resultCount: results.length,
        duration,
      });

      return results;
    } catch (error) {
      await this.emitEvent({
        type: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        context: { operation: "query", options },
      });
      throw error;
    }
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
    isAdd: boolean
  ): Promise<void> {
    if (datoms.length === 0) {
      return;
    }

    // Group datoms by attribute for efficient validation
    const byAttribute = new Map<string, DatomInput[]>();
    for (const datom of datoms) {
      const attrKey = String(datom[1]);
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
          const [, attribute, value] = datom;
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
          const key = `${String(datom[0])}|${String(datom[1])}`;
          if (entityAttributePairs.has(key)) {
            // Multiple values for same entity-attribute pair in this batch
            throw new CardinalityError(
              String(datom[1]),
              String(datom[0]),
              "multiple_values_in_batch"
            );
          }
          entityAttributePairs.set(key, datom);
        }

        // Batch query for existing values
        for (const datom of entityAttributePairs.values()) {
          // Use the original datom entity/attribute instead of splitting the key
          // to preserve the original types (number vs string)
          const entity = datom[0];
          const attribute = datom[1];
          const newValue = datom[2];
          const existingValues = await this.getValues(
            entity,
            String(attribute)
          );
          if (existingValues.length > 0) {
            // If the existing value is the same as what we're trying to add, allow it (idempotent)
            // This is useful for imports where the same datom might appear multiple times
            const existingValue = existingValues[0];
            if (JSON.stringify(existingValue) !== JSON.stringify(newValue)) {
              throw new CardinalityError(
                String(attribute),
                String(entity),
                "existing_value_conflict"
              );
            }
          }
        }
      }

      // Batch uniqueness checks: group by (attribute, value)
      if (isAdd && definition.unique) {
        const valueGroups = new Map<string, DatomInput[]>();
        for (const datom of attrDatoms) {
          const valueKey = JSON.stringify(datom[2]);
          if (!valueGroups.has(valueKey)) {
            valueGroups.set(valueKey, []);
          }
          valueGroups.get(valueKey)!.push(datom);
        }

        // Batch query for existing datoms with same attribute-value
        for (const [valueKey, valueDatoms] of valueGroups) {
          const value = JSON.parse(valueKey) as Value;
          const existingDatoms = await this.datoms({
            attribute: attrKey,
            value,
          });

          if (existingDatoms.length > 0) {
            const existingEntity = existingDatoms[0]?.entity;
            // Check if any of the new datoms have a different entity
            for (const datom of valueDatoms) {
              if (
                existingEntity !== undefined &&
                String(datom[0]) !== String(existingEntity)
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
   * Explain a query to get optimization hints and execution plan
   * Returns information about how the query will be executed, including
   * estimated costs, indexes used, and scan types.
   *
   * **Implementation Note:** Backend implementations can override this method
   * to provide backend-specific explain details (e.g., SQL EXPLAIN ANALYZE).
   * The default implementation provides basic analysis based on query options.
   *
   * @param options Query options to explain
   * @returns Query explanation result with optimization hints
   * @example
   * const explanation = await db.explainQuery({ attribute: "name", value: "Alice" });
   * console.log(`Estimated rows: ${explanation.estimatedRows}`);
   * console.log(`Indexes used: ${explanation.indexesUsed?.join(", ")}`);
   * if (explanation.warnings) {
   *   console.warn("Warnings:", explanation.warnings);
   * }
   */
  async explainQuery(options: QueryOptions): Promise<QueryExplainResult> {
    await this.ensureInitialized();
    const result: QueryExplainResult = {};

    // Basic analysis based on query options
    const hasEntityFilter = options.entity !== undefined;
    const hasAttributeFilter = options.attribute !== undefined;
    const hasValueFilter = options.value !== undefined;
    const hasTxFilter = options.tx !== undefined;
    const hasAsOfFilter = options.asOf !== undefined;
    const hasLimit = options.limit !== undefined;

    // Determine scan type
    if (hasEntityFilter || hasAttributeFilter) {
      result.scanType = "index";
      result.indexesUsed = [];
      if (hasEntityFilter) {
        result.indexesUsed.push("entity_index");
      }
      if (hasAttributeFilter) {
        result.indexesUsed.push("attribute_index");
      }
    } else if (hasValueFilter || hasTxFilter || hasAsOfFilter) {
      result.scanType = "index";
      if (hasValueFilter) {
        result.indexesUsed = ["value_index"];
      }
      if (hasTxFilter || hasAsOfFilter) {
        result.indexesUsed = result.indexesUsed || [];
        result.indexesUsed.push("tx_index");
      }
    } else {
      result.scanType = "full-table";
      result.warnings = [
        "Query lacks filters - may perform full table scan. Consider adding entity, attribute, or value filters.",
      ];
    }

    // Add warning if no limit on potentially large result set
    if (!hasLimit && result.scanType === "full-table") {
      result.warnings = result.warnings || [];
      result.warnings.push(
        "Query has no limit - may return large result set. Consider adding a limit."
      );
    }

    return result;
  }

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
   * Get a single value for an entity-attribute pair
   *
   * **Cardinality behavior:**
   * - For `cardinality: "one"` attributes: Returns the single value
   * - For `cardinality: "many"` attributes: Returns the value with the highest transaction ID (most recent)
   *
   * **Note:** For multi-valued attributes, consider using `getLatestValue()` for clarity,
   * or `getValues()` to get all values.
   *
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found. For multi-valued attributes, returns the most recent value.
   * @example
   * const value = await db.getValue(1, "name");
   * // For multi-valued attributes, returns the latest value
   * const latestTag = await db.getValue(1, "tag");
   */
  async getValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined> {
    // Don't use limit here - we need all matching datoms to find the latest one
    // For single-valued attributes, there should only be one after deduplication
    // But we still need to sort to get the latest transaction
    const datoms = await this.datoms({ entity, attribute });
    if (datoms.length === 0) {
      return undefined;
    }
    // Return the value with the highest tx (latest value for this attribute)
    // Sort by tx DESC to get the latest value first
    const sorted = datoms.sort((a, b) => b.tx - a.tx);
    return sorted[0].value;
  }

  /**
   * Get the most recent value for an entity-attribute pair
   * Explicitly returns the value with the highest transaction ID (most recent).
   * This is equivalent to `getValue()` but makes the intent clearer for multi-valued attributes.
   *
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The most recent value or undefined if not found
   * @example
   * // Get the latest tag added to an entity
   * const latestTag = await db.getLatestValue(42, "tag");
   */
  async getLatestValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined> {
    return this.getValue(entity, attribute);
  }

  /**
   * Get all values for an entity-attribute pair (for multi-valued attributes)
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns Array of values
   * @example
   * const values = await db.getValues(10, "tag"); // ["foo", "bar"]
   */
  async getValues(entity: EntityId, attribute: string): Promise<Value[]> {
    const datoms = await this.datoms({ entity, attribute });
    return datoms.map((d) => d.value);
  }

  /**
   * Check if a fact exists
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param value Value to check
   * @returns True if the fact exists
   * @example
   * const exists = await db.hasFact(123, "status", "active");
   */
  async hasFact(
    entity: EntityId,
    attribute: string,
    value: Value
  ): Promise<boolean> {
    const datoms = await this.datoms({ entity, attribute, value });
    return datoms.length > 0;
  }

  /**
   * Execute a batch query for multiple entity-attribute pairs.
   * Implementations can override this method to perform true batching
   * (e.g., a single SQL query with IN clauses) instead of parallel individual queries.
   *
   * **Type Safety Note:** The returned map uses string keys in the format "entity|attribute".
   * Callers should use the same key format when accessing results. For type-safe access,
   * use the helper method `getBatchQueryKey()` to generate keys consistently.
   *
   * **Performance:** Default implementation uses parallel queries with concurrency limit.
   * SQL implementations should override for single-query batching (much faster).
   *
   * @param queries Array of {entity, attribute} pairs to query
   * @returns Map keyed by "entity|attribute" to the value (or undefined if not found)
   * @example
   * // Default implementation uses parallel queries with concurrency limit
   * // Override in SQL implementations for single-query batching:
   * protected async executeBatchQuery(
   *   queries: Array<{entity: EntityId, attribute: string}>
   * ): Promise<Map<string, Value | undefined>> {
   *   // Single SQL: SELECT entity, attribute, value FROM datoms WHERE ...
   * }
   */
  protected async executeBatchQuery(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<Map<string, Value | undefined>> {
    if (queries.length === 0) {
      return new Map();
    }

    // Default implementation: parallel individual queries with concurrency limit
    // Limit concurrent queries to prevent overwhelming the database
    const results: Array<{ key: string; value: Value | undefined }> = [];

    for (let i = 0; i < queries.length; i += this.batchQueryConcurrencyLimit) {
      const chunk = queries.slice(i, i + this.batchQueryConcurrencyLimit);
      const chunkResults = await Promise.all(
        chunk.map(async (q) => {
          const value = await this.getValue(q.entity, q.attribute);
          const key = this.getBatchQueryKey(q.entity, q.attribute);
          return { key, value };
        })
      );
      results.push(...chunkResults);
    }

    return new Map(results.map((r) => [r.key, r.value]));
  }

  /**
   * Generate a consistent key for batch query results.
   * This ensures type-safe key generation for entity-attribute pairs.
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns String key in format "entity|attribute"
   * @internal
   */
  protected getBatchQueryKey(entity: EntityId, attribute: string): string {
    return `${String(entity)}|${String(attribute)}`;
  }

  /**
   * Batch get values for multiple entity-attribute pairs
   * @param queries Array of {entity, attribute} pairs to query
   * @returns Array of values in the same order as queries (undefined if not found)
   * @example
   * const values = await db.getValuesBatch([
   *   { entity: 1, attribute: "name" },
   *   { entity: 2, attribute: "age" },
   *   { entity: 1, attribute: "email" }
   * ]);
   * // Returns: ["Alice", 30, "alice@example.com"]
   */
  async getValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<(Value | undefined)[]> {
    await this.ensureInitialized();
    if (queries.length === 0) {
      return [];
    }
    // Use batch query method (implementations can override for optimization)
    const batchResults = await this.executeBatchQuery(queries);
    // Return results in the same order as queries
    return queries.map((q) =>
      batchResults.get(this.getBatchQueryKey(q.entity, q.attribute))
    );
  }

  /**
   * Batch get all values for multiple entity-attribute pairs (for multi-valued attributes)
   * @param queries Array of {entity, attribute} pairs to query
   * @returns Array of value arrays in the same order as queries
   * @example
   * const allValues = await db.getAllValuesBatch([
   *   { entity: 1, attribute: "tag" },
   *   { entity: 2, attribute: "tag" }
   * ]);
   * // Returns: [["red", "big"], ["blue"]]
   */
  async getAllValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<Value[][]> {
    await this.ensureInitialized();
    // Execute all queries in parallel for better performance
    const results = await Promise.all(
      queries.map((q) => this.getValues(q.entity, q.attribute))
    );
    return results;
  }

  /**
   * Find all entities that have a specific attribute-value pair
   * @param attribute Attribute name
   * @param value Value to search for
   * @returns Array of entity IDs that have this attribute-value pair
   * @example
   * const users = await db.findEntities("status", "active");
   * // Returns: [1, 5, 42]
   */
  async findEntities(attribute: string, value: Value): Promise<EntityId[]> {
    await this.ensureInitialized();
    const datoms = await this.datoms({ attribute, value });
    // Extract unique entity IDs
    const entitySet = new Set<EntityId>();
    for (const datom of datoms) {
      entitySet.add(datom.entity);
    }
    return Array.from(entitySet);
  }

  /**
   * Query full history of changes (all datoms matching filters, not just latest)
   * @param options Query options (supports pagination with limit/offset)
   * @returns Array of all matching datoms ordered by transaction ID
   * @example
   * // Basic history query
   * const history = await db.queryHistory({ entity: 1 });
   *
   * // Paginated history query
   * const page1 = await db.queryHistory({ attribute: "status", limit: 20, offset: 0 });
   */
  async queryHistory(options?: QueryOptions): Promise<Datom[]> {
    // For history queries, use the explicit history flag
    // Remove asOf if present since history queries show all changes
    if (options) {
      const { asOf, ...historyOptions } = options;
      // asOf is intentionally ignored for history queries
      void asOf;
      return this.datoms({ ...historyOptions, history: true });
    }
    return this.datoms({ history: true });
  }

  /**
   * Get all datoms for a specific entity at a specific transaction ID
   * @param entity Entity ID
   * @param tx Transaction ID to query at
   * @returns Array of datoms for the entity at that point in time
   * @example
   * const snapshot = await db.getEntityAsOf(999, 50);
   */
  async getEntityAsOf(entity: EntityId, tx: TransactionId): Promise<Datom[]> {
    return this.datoms({ entity, asOf: tx, added: true });
  }

  /**
   * Get a single value for an entity-attribute pair at a specific transaction ID
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param tx Transaction ID to query at
   * @returns The value or undefined if not found at that point in time
   * @example
   * const oldName = await db.getValueAsOf(1, "name", 55);
   */
  async getValueAsOf(
    entity: EntityId,
    attribute: string,
    tx: TransactionId
  ): Promise<Value | undefined> {
    const datoms = await this.datoms({ entity, attribute, asOf: tx });
    if (datoms.length === 0) {
      return undefined;
    }
    // Return the value with the highest tx (latest value for this attribute at that point in time)
    // Sort by tx DESC to get the latest value first
    const sorted = datoms.sort((a, b) => b.tx - a.tx);
    return sorted[0].value;
  }

  /**
   * Execute a callback within a transaction.
   * All operations performed through the transaction object will be
   * part of the same transaction. If the callback throws an error,
   * the transaction will be rolled back automatically.
   *
   * **Transaction Isolation:**
   * - Transactions use READ COMMITTED isolation by default (configurable via `isolationLevel`)
   * - Within a transaction, all reads see uncommitted changes from earlier operations in the same transaction
   * - Concurrent transactions do not see each other's uncommitted changes
   * - If a transaction throws an error, all changes are automatically rolled back
   * - Isolation levels: READ_UNCOMMITTED, READ_COMMITTED (default), REPEATABLE_READ, SERIALIZABLE
   *
   * **Optimistic Locking:**
   * - Use `options.expectedTxId` to ensure the database hasn't changed since you last read it
   * - If a conflict is detected, the transaction will fail with `TransactionConflictError`
   * - Configure retries with `options.retry` to automatically retry on conflicts
   *
   * **Transaction Timeouts:**
   * - Use `options.timeoutMs` to set a per-transaction timeout
   * - If timeout is exceeded, transaction is rolled back and `QueryTimeoutError` is thrown
   * - Timeout starts when transaction begins, includes all operations within the callback
   *
   * @param callback Function that receives a transaction object
   * @param options Optional transaction options (isolation level, timeout, optimistic locking)
   * @returns The return value of the callback
   * @example
   * // Basic transaction
   * await db.transaction(async (tx) => {
   *   await tx.add([[101, "flag", true]]);
   *   const has = await tx.hasFact(101, "flag", true);
   * });
   *
   * // With optimistic locking and retries
   * await db.transaction(
   *   async (tx) => {
   *     await tx.add([[101, "flag", true]]);
   *   },
   *   {
   *     expectedTxId: 100,
   *     retry: { maxRetries: 3, delayMs: 100 }
   *   }
   * );
   *
   * // With timeout and isolation level
   * await db.transaction(
   *   async (tx) => {
   *     await tx.add([[101, "flag", true]]);
   *   },
   *   {
   *     timeoutMs: 5000,
   *     isolationLevel: "REPEATABLE_READ"
   *   }
   * );
   */
  async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    await this.ensureInitialized();

    const maxRetries = options?.retry?.maxRetries ?? 0;
    const delayMs = options?.retry?.delayMs ?? 100;
    const timeoutMs = options?.timeoutMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Check optimistic lock if specified
        if (options?.expectedTxId !== undefined) {
          const currentTxId = await this.getLatestTransaction();
          if (currentTxId !== options.expectedTxId) {
            throw new TransactionConflictError(
              `Transaction conflict: expected txId ${options.expectedTxId}, but current is ${currentTxId}`,
              options.expectedTxId,
              currentTxId
            );
          }
        }

        const startTime = Date.now();

        // Execute transaction with timeout if specified
        let result: T;
        if (timeoutMs !== undefined && timeoutMs > 0) {
          const timeoutError = new QueryTimeoutError(timeoutMs, {
            operation: "transaction",
          });
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(timeoutError);
            }, timeoutMs);
          });

          // Wrap callback to race with timeout - if timeout fires,
          // callback throws, which triggers rollback in executeTransaction
          const timedCallback = async (tx: Transaction): Promise<T> => {
            return await Promise.race([callback(tx), timeoutPromise]);
          };

          result = await this.executeTransaction(
            timedCallback,
            options?.isolationLevel
          );
        } else {
          result = await this.executeTransaction(
            callback,
            options?.isolationLevel
          );
        }

        const duration = Date.now() - startTime;

        await this.recordTransactionMetrics(duration);

        return result;
      } catch (error) {
        // Retry on transaction conflicts if retries are configured
        if (error instanceof TransactionConflictError && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw error;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error("Transaction failed after retries");
  }

  /**
   * Internal method to execute a transaction
   * Implementations should override this method
   * @param callback Transaction callback
   * @param isolationLevel Optional isolation level (default: READ_COMMITTED)
   * @returns The result of the callback
   */
  protected abstract executeTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    isolationLevel?: import("../types.js").TransactionIsolationLevel
  ): Promise<T>;

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
    const firstPendingVersion = currentVersion + 1;
    const hasPendingMigrations = firstPendingVersion <= targetVersion;

    // Warn if migration state tracking is not implemented and we have migrations to run
    // Check on first migration attempt (version 1) if state tracking is not implemented
    if (hasPendingMigrations && firstPendingVersion === 1) {
      const migrationState = await this.getMigrationState(1);
      if (migrationState === undefined && this.logger) {
        this.logger.warn(
          "Migration state tracking not implemented - migrations may re-run on restart. Override getMigrationState() and saveMigrationState() to persist migration state."
        );
      }
    }

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
        if (this.logger) {
          this.logger.info(
            `Running migration ${migration.version}: ${migration.name}`
          );
        }

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
          `Migration ${migration.version} (${migration.name}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          migration.version,
          error instanceof Error ? error : undefined
        );

        await this.emitEvent({
          type: "migration",
          version: migration.version,
          success: false,
          error: migrationError,
        });

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
        if (this.logger) {
          this.logger.info(
            `Rolling back migration ${migration.version}: ${migration.name}`
          );
        }

        await migration.down(this);

        // Mark migration as rolled back
        await this.markMigrationRolledBack(migration.version);

        // Update schema version directly (rollback doesn't go through migrate())
        // This avoids the backward migration check in migrate()
        this.schemaVersion = migration.version - 1;
      } catch (error) {
        const rollbackError = new MigrationRollbackError(
          `Rollback of migration ${migration.version} (${
            migration.name
          }) failed: ${error instanceof Error ? error.message : String(error)}`,
          migration.version,
          error instanceof Error ? error : undefined
        );

        await this.emitEvent({
          type: "migration",
          version: migration.version,
          success: false,
          error: rollbackError,
        });

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
        const error = new MigrationError(
          `Cannot migrate backwards from version ${this.schemaVersion} to ${targetVersion}`,
          targetVersion
        );
        await this.emitEvent({
          type: "migration",
          version: targetVersion,
          success: false,
          error,
        });
        throw error;
      }

      await this.onMigrate(this.schemaVersion, targetVersion);
      this.schemaVersion = targetVersion;
      await this.emitEvent({
        type: "migration",
        version: targetVersion,
        success: true,
      });
    } catch (error) {
      // If error is already a MigrationError (backward migration), event was already emitted
      if (error instanceof MigrationError) {
        throw error;
      }
      // For other errors during onMigrate, emit event and wrap in MigrationError
      await this.emitEvent({
        type: "migration",
        version: targetVersion,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new MigrationError(
        `Migration to version ${targetVersion} failed: ${
          error instanceof Error ? error.message : String(error)
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
   * Register an event listener for database events
   * @param eventType Type of event to listen for
   * @param listener Callback function to handle events
   * @returns Function to unsubscribe the listener
   * @example
   * const unsubscribe = db.on("transaction", (event) => {
   *   console.log(`Transaction ${event.txId} completed`);
   * });
   * // Later...
   * unsubscribe();
   */
  on(
    eventType: DatabaseEvent["type"],
    listener: DatabaseEventListener
  ): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set());
    }
    this.eventListeners.get(eventType)!.add(listener);
    // Return unsubscribe function
    return () => {
      this.eventListeners.get(eventType)?.delete(listener);
    };
  }

  /**
   * Emit an event to all registered listeners
   * Handles async errors gracefully to prevent one failing listener from breaking others.
   * Also logs events if a logger is configured.
   * @param event Event to emit
   * @internal
   */
  protected async emitEvent(event: DatabaseEvent): Promise<void> {
    // Log event if logger is configured
    if (this.logger) {
      const logLevel =
        event.type === "error"
          ? "error"
          : event.type === "query"
          ? "debug"
          : "info";
      const logMeta: Record<string, unknown> = { eventType: event.type };

      if (event.type === "transaction") {
        logMeta.txId = event.txId;
        logMeta.addedCount = event.addedCount;
        logMeta.retractedCount = event.retractedCount;
      } else if (event.type === "query") {
        logMeta.resultCount = event.resultCount;
        logMeta.duration = event.duration;
      } else if (event.type === "error") {
        logMeta.error = event.error.message;
        logMeta.errorStack = event.error.stack;
      } else if (event.type === "migration") {
        logMeta.version = event.version;
        logMeta.success = event.success;
      } else if (event.type === "backup" || event.type === "restore") {
        logMeta.datomCount = event.datomCount;
        logMeta.success = event.success;
      }

      if (logLevel === "error") {
        this.logger.error(`Database event: ${event.type}`, logMeta);
      } else if (logLevel === "debug") {
        this.logger.debug(`Database event: ${event.type}`, logMeta);
      } else {
        this.logger.info(`Database event: ${event.type}`, logMeta);
      }
    }

    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      // Use Promise.allSettled to ensure all listeners are called even if some fail
      const results = await Promise.allSettled(
        Array.from(listeners).map(async (listener) => {
          return await listener(event);
        })
      );

      // Emit error events for failed listeners, but don't let that break the flow
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "rejected") {
          try {
            await this.emitEvent({
              type: "error",
              error:
                result.reason instanceof Error
                  ? result.reason
                  : new Error(String(result.reason)),
              context: {
                eventType: event.type,
                listenerError: true,
              },
            });
          } catch (emitError) {
            // Ignore errors in error event emission to prevent infinite loops
            // Log to logger if available, otherwise console
            const errorMsg = `Failed to emit error event for listener failure: ${emitError}`;
            if (this.logger) {
              this.logger.error(errorMsg, { error: emitError });
            } else {
              console.error(errorMsg, emitError);
            }
          }
        }
      }
    }
  }

  /**
   * Get database statistics for observability
   * @returns Database statistics
   * @example
   * const stats = await db.getStats();
   * console.log(`Total datoms: ${stats.totalDatoms}`);
   * console.log(`Latest transaction: ${stats.latestTransaction}`);
   */
  async getStats(): Promise<DatabaseStats> {
    await this.ensureInitialized();
    const latestTx = await this.getLatestTransaction();
    const stats: DatabaseStats = {
      totalDatoms: 0,
      totalEntities: 0,
      totalTransactions: latestTx,
      latestTransaction: latestTx,
      schemaAttributeCount: this.schema.size,
    };

    // Try to get more detailed stats (implementations can override)
    const detailedStats = await this.getDetailedStats();
    Object.assign(stats, detailedStats);

    // Query and transaction metrics are now tracked by implementations
    // Implementations can override getDetailedStats() to include these metrics

    return stats;
  }

  /**
   * Perform a health check on the database
   * Returns detailed health status including connection pool, query performance, and transaction health
   * @returns Database health status
   * @example
   * const health = await db.healthCheck();
   * if (health.status === "unhealthy") {
   *   console.error("Database is unhealthy:", health.errors);
   * }
   */
  async healthCheck(): Promise<DatabaseHealth> {
    await this.ensureInitialized();
    const timestamp = new Date().toISOString();
    const errors: string[] = [];
    const warnings: string[] = [];
    let overallStatus: DatabaseHealth["status"] = "healthy";

    // Check connection pool health
    const connectionPool = await this.getConnectionHealth();
    if (connectionPool) {
      const poolHealthy =
        connectionPool.waitingRequests === 0 &&
        connectionPool.activeConnections <
          connectionPool.totalConnections * 0.9; // Less than 90% capacity

      if (!poolHealthy) {
        warnings.push(
          `Connection pool at ${Math.round(
            (connectionPool.activeConnections /
              connectionPool.totalConnections) *
              100
          )}% capacity`
        );
        if (connectionPool.waitingRequests > 0) {
          overallStatus = "degraded";
          errors.push(
            `${connectionPool.waitingRequests} requests waiting for connections`
          );
        }
      }
    }

    // Check query performance
    const stats = await this.getStats();
    const queryPerformance = stats.queryMetrics
      ? {
          healthy: true,
          averageQueryTime: stats.queryMetrics.averageQueryTime,
          slowQueries: 0, // Implementations can track this
          details: `Average query time: ${stats.queryMetrics.averageQueryTime?.toFixed(
            3
          )}s`,
        }
      : undefined;

    if (
      queryPerformance &&
      queryPerformance.averageQueryTime !== undefined &&
      queryPerformance.averageQueryTime > 1.0
    ) {
      // Average query time > 1 second is considered slow
      warnings.push(
        `Average query time is ${queryPerformance.averageQueryTime.toFixed(
          3
        )}s (consider optimization)`
      );
      if (queryPerformance.averageQueryTime > 5.0) {
        overallStatus = "degraded";
      }
    }

    // Check transaction health
    const transactionHealth = stats.transactionMetrics
      ? {
          healthy: true,
          averageTransactionTime:
            stats.transactionMetrics.averageTransactionTime,
          failedTransactions: 0, // Implementations can track this
          details: `Average transaction time: ${stats.transactionMetrics.averageTransactionTime?.toFixed(
            3
          )}s`,
        }
      : undefined;

    if (
      transactionHealth &&
      transactionHealth.averageTransactionTime !== undefined &&
      transactionHealth.averageTransactionTime > 2.0
    ) {
      // Average transaction time > 2 seconds is considered slow
      warnings.push(
        `Average transaction time is ${transactionHealth.averageTransactionTime.toFixed(
          3
        )}s (consider optimization)`
      );
      if (transactionHealth.averageTransactionTime > 10.0) {
        overallStatus = "degraded";
      }
    }

    // If we have errors, mark as unhealthy
    if (errors.length > 0) {
      overallStatus = "unhealthy";
    } else if (warnings.length > 0 && overallStatus === "healthy") {
      overallStatus = "degraded";
    }

    return {
      status: overallStatus,
      timestamp,
      connectionPool: connectionPool
        ? {
            healthy:
              connectionPool.waitingRequests === 0 &&
              connectionPool.activeConnections <
                connectionPool.totalConnections * 0.9,
            activeConnections: connectionPool.activeConnections,
            idleConnections: connectionPool.idleConnections,
            waitingRequests: connectionPool.waitingRequests,
            details: `Active: ${connectionPool.activeConnections}/${connectionPool.totalConnections}, Waiting: ${connectionPool.waitingRequests}`,
          }
        : undefined,
      queryPerformance,
      transactionHealth,
      details:
        overallStatus === "healthy"
          ? "All systems operational"
          : `${errors.length} error(s), ${warnings.length} warning(s)`,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Get connection health information
   * Implementations can override this to provide connection pool statistics
   * @returns Connection pool stats or undefined if not applicable
   */
  protected async getConnectionHealth(): Promise<
    import("../types.js").ConnectionPoolStats | undefined
  > {
    // Default: no connection pool (in-memory implementations)
    // SQL implementations should override this
    return undefined;
  }

  /**
   * Hook for implementations to provide detailed statistics
   * Override this method to provide backend-specific stats
   * @returns Partial stats object with implementation-specific metrics
   */
  protected async getDetailedStats(): Promise<
    Partial<Pick<DatabaseStats, "totalDatoms" | "totalEntities">>
  > {
    return {};
  }

  /**
   * Record query metrics for observability.
   * Implementations can override this to track metrics in a thread-safe manner.
   * Default implementation is a no-op - implementations should track metrics themselves.
   * @param duration Query duration in milliseconds
   * @internal
   */
  protected async recordQueryMetrics(_duration: number): Promise<void> {
    // Default: no-op. Implementations should override to track metrics thread-safely.
  }

  /**
   * Record transaction metrics for observability.
   * Implementations can override this to track metrics in a thread-safe manner.
   * Default implementation is a no-op - implementations should track metrics themselves.
   * @param duration Transaction duration in milliseconds
   * @internal
   */
  protected async recordTransactionMetrics(_duration: number): Promise<void> {
    // Default: no-op. Implementations should override to track metrics thread-safely.
  }

  /**
   * Export all datoms from the database as an async iterable
   * Useful for backup, replication, and migration scenarios
   *
   * **Note:** This method bypasses query safety checks and can perform full table scans.
   * Use filters in options to limit the export scope when possible.
   *
   * @param options Optional export options (filters are recommended but not required)
   * @returns Async iterable of datoms
   * @example
   * // Stream all datoms to a file (full export)
   * const stream = db.export();
   * for await (const datom of stream) {
   *   await writeDatomToFile(datom);
   * }
   *
   * // Export with filters (recommended for large databases)
   * const filtered = db.export({ attribute: "status" });
   * for await (const datom of filtered) {
   *   // Process datom
   * }
   */
  async *export(options?: QueryOptions): AsyncIterable<Datom> {
    await this.ensureInitialized();
    let datomCount = 0;
    try {
      // Use queryInternal to bypass safety checks for export (explicit operation)
      const datoms = await this.queryInternal(options || {});
      for (const datom of datoms) {
        yield datom;
        datomCount++;
      }
      await this.emitEvent({
        type: "backup",
        datomCount,
        success: true,
      });
    } catch (error) {
      await this.emitEvent({
        type: "backup",
        datomCount,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  /**
   * Import datoms into the database from an async iterable
   * Useful for restore, replication, and migration scenarios
   * @param source Async iterable of datoms to import
   * @param options Optional import options
   * @returns Number of datoms imported
   * @example
   * // Import from a file
   * const datoms = readDatomsFromFile();
   * const count = await db.import(datoms);
   * console.log(`Imported ${count} datoms`);
   */
  async import(
    source: AsyncIterable<Datom>,
    options?: { batchSize?: number; validate?: boolean }
  ): Promise<number> {
    await this.ensureInitialized();
    const batchSize = options?.batchSize ?? 1000;
    const validate = options?.validate ?? true;
    let datomCount = 0;
    let batch: DatomInput[] = [];
    let batchAdded: boolean[] = []; // Track which datoms in batch are added vs retracted

    try {
      for await (const datom of source) {
        // Convert Datom to DatomInput
        batch.push([datom.entity, datom.attribute, datom.value]);
        batchAdded.push(datom.added);

        if (batch.length >= batchSize) {
          // Process batch: separate added and retracted datoms
          const addedBatch: DatomInput[] = [];
          const retractedBatch: DatomInput[] = [];
          for (let i = 0; i < batch.length; i++) {
            if (batchAdded[i]) {
              addedBatch.push(batch[i]);
            } else {
              retractedBatch.push(batch[i]);
            }
          }

          // Deduplicate batches: keep only the latest occurrence of each (entity, attribute, value) pair
          const dedupeAdded = this.deduplicateBatch(addedBatch);
          const dedupeRetracted = this.deduplicateBatch(retractedBatch);

          if (validate) {
            if (dedupeAdded.length > 0) {
              await this.validateDatoms(dedupeAdded, true);
            }
            if (dedupeRetracted.length > 0) {
              await this.validateDatoms(dedupeRetracted, false);
            }
          }

          // Filter out datoms that already exist with the same value (idempotent import)
          const filteredAdded = await this.filterExistingDatoms(dedupeAdded);
          const filteredRetracted = await this.filterExistingDatoms(
            dedupeRetracted
          );

          if (filteredAdded.length > 0) {
            await this.add(filteredAdded);
          }
          if (filteredRetracted.length > 0) {
            await this.retract(filteredRetracted);
          }

          datomCount += batch.length;
          batch = [];
          batchAdded = [];
        }
      }

      // Process remaining batch
      if (batch.length > 0) {
        // Separate added and retracted datoms
        const addedBatch: DatomInput[] = [];
        const retractedBatch: DatomInput[] = [];
        for (let i = 0; i < batch.length; i++) {
          if (batchAdded[i]) {
            addedBatch.push(batch[i]);
          } else {
            retractedBatch.push(batch[i]);
          }
        }

        // Deduplicate batches: keep only the latest occurrence of each (entity, attribute, value) pair
        const dedupeAdded = this.deduplicateBatch(addedBatch);
        const dedupeRetracted = this.deduplicateBatch(retractedBatch);

        if (validate) {
          if (dedupeAdded.length > 0) {
            await this.validateDatoms(dedupeAdded, true);
          }
          if (dedupeRetracted.length > 0) {
            await this.validateDatoms(dedupeRetracted, false);
          }
        }

        // Filter out datoms that already exist with the same value (idempotent import)
        const filteredAdded = await this.filterExistingDatoms(dedupeAdded);
        const filteredRetracted = await this.filterExistingDatoms(
          dedupeRetracted
        );

        if (filteredAdded.length > 0) {
          await this.add(filteredAdded);
        }
        if (filteredRetracted.length > 0) {
          await this.retract(filteredRetracted);
        }
        datomCount += batch.length;
      }

      await this.emitEvent({
        type: "restore",
        datomCount,
        success: true,
      });

      return datomCount;
    } catch (error) {
      await this.emitEvent({
        type: "restore",
        datomCount,
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  /**
   * Deduplicate a batch of datoms, keeping only the latest occurrence of each (entity, attribute, value) pair.
   * This is useful when importing data that may contain duplicates.
   * Uses value comparison helper to handle Date objects and other special types correctly.
   *
   * **Performance:** Single-pass Map accumulation for O(n) complexity.
   * Processes in chunks for very large batches to prevent memory issues.
   */
  private deduplicateBatch(batch: DatomInput[]): DatomInput[] {
    if (batch.length === 0) {
      return batch;
    }

    // For very large batches, process in chunks to prevent memory issues
    const MAX_BATCH_SIZE = 10000;
    if (batch.length > MAX_BATCH_SIZE) {
      const chunks: DatomInput[][] = [];
      for (let i = 0; i < batch.length; i += MAX_BATCH_SIZE) {
        chunks.push(batch.slice(i, i + MAX_BATCH_SIZE));
      }
      // Deduplicate each chunk, then merge results
      const deduplicatedChunks = chunks.map((chunk) =>
        this.deduplicateBatch(chunk)
      );
      // Final deduplication pass on merged chunks
      return this.deduplicateBatch(deduplicatedChunks.flat());
    }

    // Single-pass Map accumulation for O(n) complexity
    const seen = new Map<string, DatomInput>();
    for (const datom of batch) {
      // Use a key that handles Date objects and other types correctly
      const valueKey = this.getValueKey(datom[2]);
      const key = `${String(datom[0])}|${String(datom[1])}|${valueKey}`;
      seen.set(key, datom); // Later occurrences overwrite earlier ones
    }
    return Array.from(seen.values());
  }

  /**
   * Generate a consistent key for a value, handling Date objects and other special types.
   * This is more reliable than JSON.stringify for Date objects.
   * @param value Value to generate key for
   * @returns String key representing the value
   * @internal
   */
  private getValueKey(value: Value): string {
    // Handle Date objects specially to avoid JSON.stringify issues
    if (value instanceof Date) {
      return `__DATE__${value.toISOString()}`;
    }
    // Use JSON.stringify for other types
    return JSON.stringify(value);
  }

  /**
   * Filter out datoms that already exist in the database with the same value.
   * This makes imports idempotent - re-importing the same data won't cause errors.
   * Uses batch queries for better performance on large imports.
   *
   * **Performance:** Uses batch queries and Map-based lookups for O(n) complexity
   * instead of O(n²) array searches.
   */
  private async filterExistingDatoms(
    batch: DatomInput[]
  ): Promise<DatomInput[]> {
    if (batch.length === 0) {
      return batch;
    }

    // Process in chunks to avoid memory issues with very large batches
    const CHUNK_SIZE = 1000;
    const filtered: DatomInput[] = [];

    for (
      let chunkStart = 0;
      chunkStart < batch.length;
      chunkStart += CHUNK_SIZE
    ) {
      const chunk = batch.slice(chunkStart, chunkStart + CHUNK_SIZE);

      // Batch query for existing values to avoid N+1 queries
      const queries = chunk.map(([entity, attribute]) => ({
        entity,
        attribute: String(attribute),
      }));
      const existingValuesBatch = await this.getAllValuesBatch(queries);

      // Build Map for O(1) lookups: key is entity|attribute, value is Set of values
      const existingValuesMap = new Map<string, Set<string>>();
      for (let i = 0; i < chunk.length; i++) {
        const [entity, attribute] = chunk[i];
        const key = `${String(entity)}|${String(attribute)}`;
        const existingValues = existingValuesBatch[i];

        if (existingValues.length > 0) {
          // Convert values to string keys for Set membership testing
          const valueSet = new Set<string>();
          for (const val of existingValues) {
            valueSet.add(this.getValueKey(val));
          }
          existingValuesMap.set(key, valueSet);
        }
      }

      // Filter chunk using Map-based lookups
      for (let i = 0; i < chunk.length; i++) {
        const [entity, attribute, value] = chunk[i];
        const key = `${String(entity)}|${String(attribute)}`;
        const existingValueSet = existingValuesMap.get(key);

        // Only include if value doesn't exist or is different
        if (
          !existingValueSet ||
          !existingValueSet.has(this.getValueKey(value))
        ) {
          filtered.push(chunk[i]);
        }
        // If value matches, skip (idempotent)
      }
    }

    return filtered;
  }

  /**
   * Compare two values for equality, handling Date objects and other special types.
   * This is more reliable than JSON.stringify for Date objects.
   * @param a First value
   * @param b Second value
   * @returns True if values are equal
   * @internal
   */
  private valuesEqual(a: Value, b: Value): boolean {
    // Handle Date objects specially
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    if (a instanceof Date || b instanceof Date) {
      return false;
    }
    // Use JSON.stringify for other types (handles null, undefined, primitives, objects)
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Check if an entity exists in the database
   * @param entity Entity ID to check
   * @returns True if the entity has any datoms
   * @example
   * if (await db.exists(123)) {
   *   console.log("Entity 123 exists");
   * }
   */
  async exists(entity: EntityId): Promise<boolean> {
    await this.ensureInitialized();
    const datoms = await this.datoms({ entity, limit: 1 });
    return datoms.length > 0;
  }

  /**
   * Upsert multiple values atomically
   * For each entity-attribute pair, retracts existing values if cardinality is "one" and adds the new value
   * @param upserts Array of {entity, attribute, value} objects to upsert
   * @returns The transaction ID
   * @example
   * await db.upsertMany([
   *   { entity: 1, attribute: "name", value: "Alice" },
   *   { entity: 2, attribute: "name", value: "Bob" },
   *   { entity: 1, attribute: "status", value: "active" }
   * ]);
   */
  async upsertMany(
    upserts: Array<{ entity: EntityId; attribute: string; value: Value }>
  ): Promise<TransactionId> {
    await this.ensureInitialized();
    if (upserts.length === 0) {
      return this.transact({});
    }

    // Group by attribute to batch validation
    const byAttribute = new Map<
      string,
      Array<{ entity: EntityId; attribute: string; value: Value }>
    >();
    for (const upsert of upserts) {
      const attrKey = String(upsert.attribute);
      if (!byAttribute.has(attrKey)) {
        byAttribute.set(attrKey, []);
      }
      byAttribute.get(attrKey)!.push(upsert);
    }

    // Collect retractions and additions
    const toRetract: DatomInput[] = [];
    const toAdd: DatomInput[] = [];

    for (const [attrKey, attrUpserts] of byAttribute) {
      const definition = this.getAttributeDefinition(attrKey);
      const isCardinalityOne = definition?.cardinality === "one";

      for (const { entity, attribute, value } of attrUpserts) {
        if (isCardinalityOne) {
          // Retract existing values
          const existingValues = await this.getValues(entity, attribute);
          for (const existingValue of existingValues) {
            toRetract.push([entity, attribute, existingValue]);
          }
        }
        toAdd.push([entity, attribute, value]);
      }
    }

    return this.transact({
      retract: toRetract.length > 0 ? toRetract : undefined,
      add: toAdd,
    });
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
