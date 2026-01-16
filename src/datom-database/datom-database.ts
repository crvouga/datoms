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
  DatabaseStats,
  EntityId,
  OptimisticLockOptions,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";
import {
  CardinalityError,
  DatomTypeError,
  MigrationError,
  QuerySafetyError,
  TransactionConflictError,
  UniqueConstraintError,
} from "./errors.js";

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
   * const datoms = await db.query({ entity: 123 });
   *
   * // Query with a filter and limit
   * const recent = await db.query({ attribute: "age", limit: 5 });
   */
  query(options: QueryOptions): Promise<Datom[]>;

  /**
   * Query database state as it existed at a specific transaction ID (time-travel query)
   * @param tx Transaction ID to query at
   * @param options Additional query options
   * @returns Array of matching datoms at that point in time
   * @example
   * // Get what entity 42 looked like as of transaction 87
   * const atOldTx = await db.queryAsOf(87, { entity: 42 });
   */
  queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query
   * @param query Datalog query to execute
   * @returns Query results as an array of records
   * @example
   * const results = await db.queryDatalog(["find", "?e", "where", ["?e", "name", "alice"]]);
   */
  queryDatalog(query: DatalogQuery): Promise<QueryResult>;

  /**
   * Get all datoms for a specific entity
   * @param entity Entity ID
   * @returns Array of datoms for the entity
   * @example
   * const datoms = await db.getEntity(1234);
   */
  getEntity(entity: EntityId): Promise<Datom[]>;

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
 * @example
 * await db.transaction(async (tx) => {
 *   await tx.add([[123, "score", 10]]);
 *   // all reads see the new datom, but not yet committed to the main db
 *   const current = await tx.getValue(123, "score");
 * });
 */
export interface Transaction extends DatomReader, DatomWriter<void> {
  /**
   * Get the transaction ID for the current transaction
   * @example
   * await db.transaction(async (tx) => {
   *   await tx.add([[1, "name", "Test"]]);
   *   const txid = tx.getTransactionId();
   * });
   */
  getTransactionId(): TransactionId;
}

/**
 * Abstract datom database class that provides a high-level interface
 * for working with datoms and datalog queries
 * Concrete implementations: InMemoryDatabase, SQLiteDatabase, PostgreSQLDatabase
 *
 * **Transaction Isolation:**
 * - Transactions use READ COMMITTED isolation by default
 * - Within a transaction, all reads see uncommitted changes from earlier operations in the same transaction
 * - Concurrent transactions do not see each other's uncommitted changes
 * - If a transaction throws an error, all changes are automatically rolled back
 * - Optimistic locking is supported via `transaction()` options for conflict detection
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
 *
 * **Backup & Recovery:**
 * - Export datoms via `export()` for backup and replication
 * - Import datoms via `import()` for restore and migration
 * - Supports streaming for large datasets
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
  private queryCount: number = 0;
  private transactionCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionTimeSum: number = 0;

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
   * @param datoms Array of datoms to add
   * @returns The transaction ID
   * @example
   * await db.add([[42, "type", "cat"]]);
   */
  abstract add(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Retract datoms from the database
   * @param datoms Array of datoms to retract
   * @returns The transaction ID
   * @example
   * await db.retract([[42, "type", "cat"]]);
   */
  abstract retract(datoms: DatomInput[]): Promise<TransactionId>;

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
    const datoms = await this.query({ entity, attribute });
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
    txId: TransactionId,
    metadata: Record<string, unknown>
  ): Promise<void> {
    // Override in implementations if metadata storage is needed
    // Default: no-op (metadata is ignored)
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
    definition: AttributeDefinition
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
          const value = JSON.parse(valueKey);
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
    name: string,
    oldDefinition: AttributeDefinition,
    newDefinition: AttributeDefinition
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
    name: string,
    definition: AttributeDefinition
  ): Promise<void> {
    // Override in implementations if needed
  }

  /**
   * Export the current schema as an array of attribute definitions
   * Useful for migrations, backups, or schema versioning
   * @returns Array of attribute definitions
   * @example
   * const schema = db.exportSchema();
   * // Save to file or version control
   * await fs.writeFile("schema.json", JSON.stringify(schema, null, 2));
   */
  exportSchema(): AttributeDefinition[] {
    return Array.from(this.schema.values());
  }

  /**
   * Import a schema from an array of attribute definitions
   * Useful for migrations or restoring schema from backup
   * @param definitions Array of attribute definitions to import
   * @example
   * // Load schema from file
   * const schema = JSON.parse(await fs.readFile("schema.json", "utf-8"));
   * await db.importSchema(schema);
   */
  async importSchema(definitions: AttributeDefinition[]): Promise<void> {
    await this.ensureInitialized();
    // Clear existing schema
    this.schema.clear();
    // Import each definition
    for (const definition of definitions) {
      await this.defineAttribute(definition);
    }
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
   * const changes = await db.query({ tx: latestTx + 1 });
   */
  abstract getLatestTransaction(): Promise<TransactionId>;

  /**
   * Query datoms from the database using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * // Query by filters to prevent accidental full table scan:
   * const datoms = await db.query({ attribute: "name", value: "Alice" });
   *
   * // Pagination example:
   * const page1 = await db.query({ attribute: "status", limit: 10, offset: 0 });
   * const page2 = await db.query({ attribute: "status", limit: 10, offset: 10 });
   */
  async query(options: QueryOptions): Promise<Datom[]> {
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

      const results = await this.executeQuery(options);
      const duration = Date.now() - startTime;

      this.queryCount++;
      this.queryTimeSum += duration;

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
        for (const [entity, attribute, value] of attrDatoms) {
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
        for (const [key, datom] of entityAttributePairs) {
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
          const value = JSON.parse(valueKey);
          const existingDatoms = await this.query({
            attribute: attrKey,
            value,
          });

          if (existingDatoms.length > 0) {
            const existingEntity = existingDatoms[0].entity;
            // Check if any of the new datoms have a different entity
            for (const datom of valueDatoms) {
              if (String(datom[0]) !== String(existingEntity)) {
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
        // EntityId can be number, string, or symbol (symbol requires special serialization)
        if (
          typeof value !== "number" &&
          typeof value !== "string" &&
          typeof value !== "symbol"
        ) {
          return new Error(
            `Attribute "${String(
              attribute
            )}" expects type "ref" (EntityId), but got ${typeof value}`
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
   * @returns Query results as an array of records
   * @example
   * const result = await db.queryDatalog(["find", "?e", "where", ["?e", "name", "Alice"]]);
   */
  abstract queryDatalog(query: DatalogQuery): Promise<QueryResult>;

  /**
   * Get all datoms for a specific entity
   * @param entity Entity ID
   * @returns Array of datoms for the entity
   * @example
   * const datoms = await db.getEntity(100);
   */
  abstract getEntity(entity: EntityId): Promise<Datom[]>;

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
    const datoms = await this.query({ entity, attribute });
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
    const datoms = await this.query({ entity, attribute });
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
    const datoms = await this.query({ entity, attribute, value });
    return datoms.length > 0;
  }

  /**
   * Execute a batch query for multiple entity-attribute pairs.
   * Implementations can override this method to perform true batching
   * (e.g., a single SQL query with IN clauses) instead of parallel individual queries.
   * @param queries Array of {entity, attribute} pairs to query
   * @returns Map keyed by "entity|attribute" to the value (or undefined if not found)
   * @example
   * // Default implementation uses parallel queries
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
    // Default implementation: parallel individual queries
    // Implementations can override for true batching (single SQL query)
    const results = await Promise.all(
      queries.map(async (q) => {
        const value = await this.getValue(q.entity, q.attribute);
        return { key: `${String(q.entity)}|${String(q.attribute)}`, value };
      })
    );
    return new Map(results.map((r) => [r.key, r.value]));
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
      batchResults.get(`${String(q.entity)}|${String(q.attribute)}`)
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
    const datoms = await this.query({ attribute, value });
    // Extract unique entity IDs
    const entitySet = new Set<EntityId>();
    for (const datom of datoms) {
      entitySet.add(datom.entity);
    }
    return Array.from(entitySet);
  }

  /**
   * Query database state as it existed at a specific transaction ID (time-travel query)
   * @param tx Transaction ID to query at
   * @param options Additional query options (supports pagination with limit/offset)
   * @returns Array of matching datoms at that point in time
   * @example
   * // Basic time-travel query
   * const old = await db.queryAsOf(55, { entity: 1 });
   *
   * // Paginated time-travel query
   * const page1 = await db.queryAsOf(100, { attribute: "status", limit: 10, offset: 0 });
   */
  async queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]> {
    return this.query({ ...options, asOf: tx });
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
    const { asOf, ...historyOptions } = options || {};
    return this.query({ ...historyOptions, history: true });
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
    return this.query({ entity, asOf: tx, added: true });
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
    const datoms = await this.query({ entity, attribute, asOf: tx });
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
   * - Transactions use READ COMMITTED isolation by default
   * - Within a transaction, all reads see uncommitted changes from earlier operations in the same transaction
   * - Concurrent transactions do not see each other's uncommitted changes
   * - If a transaction throws an error, all changes are automatically rolled back
   *
   * **Optimistic Locking:**
   * - Use `options.expectedTxId` to ensure the database hasn't changed since you last read it
   * - If a conflict is detected, the transaction will fail with `TransactionConflictError`
   * - Configure retries with `options.retry` to automatically retry on conflicts
   *
   * @param callback Function that receives a transaction object
   * @param options Optional optimistic locking options
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
   */
  async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: OptimisticLockOptions
  ): Promise<T> {
    await this.ensureInitialized();

    const maxRetries = options?.retry?.maxRetries ?? 0;
    const delayMs = options?.retry?.delayMs ?? 100;

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
        const result = await this.executeTransaction(callback);
        const duration = Date.now() - startTime;

        this.transactionCount++;
        this.transactionTimeSum += duration;

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
   */
  protected abstract executeTransaction<T>(
    callback: (tx: Transaction) => Promise<T>
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
    fromVersion: number,
    toVersion: number
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
   * @param event Event to emit
   * @internal
   */
  protected async emitEvent(event: DatabaseEvent): Promise<void> {
    const listeners = this.eventListeners.get(event.type);
    if (listeners) {
      await Promise.all(
        Array.from(listeners).map((listener) => {
          try {
            return listener(event);
          } catch (error) {
            // Emit error event for listener failures
            this.emitEvent({
              type: "error",
              error: error instanceof Error ? error : new Error(String(error)),
              context: { eventType: event.type },
            }).catch(() => {
              // Ignore errors in error event emission
            });
          }
        })
      );
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

    // Add query metrics if available
    if (this.queryCount > 0) {
      stats.queryMetrics = {
        totalQueries: this.queryCount,
        averageQueryTime: this.queryTimeSum / this.queryCount / 1000, // Convert to seconds
      };
    }

    // Add transaction metrics if available
    if (this.transactionCount > 0) {
      stats.transactionMetrics = {
        averageTransactionTime:
          this.transactionTimeSum / this.transactionCount / 1000, // Convert to seconds
      };
    }

    return stats;
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
   */
  private deduplicateBatch(batch: DatomInput[]): DatomInput[] {
    if (batch.length === 0) {
      return batch;
    }
    const seen = new Map<string, DatomInput>();
    for (const datom of batch) {
      const key = `${String(datom[0])}|${String(datom[1])}|${JSON.stringify(
        datom[2]
      )}`;
      seen.set(key, datom); // Later occurrences overwrite earlier ones
    }
    return Array.from(seen.values());
  }

  /**
   * Filter out datoms that already exist in the database with the same value.
   * This makes imports idempotent - re-importing the same data won't cause errors.
   */
  private async filterExistingDatoms(
    batch: DatomInput[]
  ): Promise<DatomInput[]> {
    if (batch.length === 0) {
      return batch;
    }
    const filtered: DatomInput[] = [];
    for (const datom of batch) {
      const [entity, attribute, value] = datom;
      const existingValues = await this.getValues(entity, String(attribute));
      // Only include if value doesn't exist or is different
      if (existingValues.length === 0) {
        filtered.push(datom);
      } else {
        const existingValue = existingValues[0];
        if (JSON.stringify(existingValue) !== JSON.stringify(value)) {
          filtered.push(datom);
        }
        // If value matches, skip (idempotent)
      }
    }
    return filtered;
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
    const datoms = await this.query({ entity, limit: 1 });
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
