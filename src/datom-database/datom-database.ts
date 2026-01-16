/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery, QueryResult } from "../datalog/datalog.js";
import type {
  AttributeDefinition,
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";

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
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found
   * @example
   * const name = await db.getValue(42, "name"); // e.g. "Alice"
   */
  getValue(entity: EntityId, attribute: string): Promise<Value | undefined>;

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
   * Execute bulk operations atomically
   * @param ops Object containing add and/or retract arrays
   * @returns The transaction ID (T)
   * @example
   * await db.transact({
   *   add: [[200, "name", "Carol"]],
   *   retract: [[100, "name", "Alice"]]
   * });
   */
  transact(ops: { add?: DatomInput[]; retract?: DatomInput[] }): Promise<T>;
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
 * @example
 * // Example usage: Create, add and query
 * class MyDb extends DatomDatabase { ... }
 * const db = new MyDb();
 * await db.initialize();
 * await db.add([[1, "name", "Alice"]]);
 * const name = await db.getValue(1, "name"); // "Alice"
 */
export abstract class DatomDatabase
  implements DatomReader, DatomWriter<TransactionId>
{
  protected initialized = false;
  protected schema: Map<string, AttributeDefinition> = new Map();

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
   * Execute bulk operations atomically
   * @param ops Object containing add and/or retract arrays
   * @returns The transaction ID
   * @example
   * await db.transact({
   *   add: [[300, "status", "active"]],
   *   retract: [[42, "type", "cat"]]
   * });
   */
  async transact(ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }): Promise<TransactionId> {
    await this.ensureInitialized();
    // Use a transaction to ensure atomicity
    return this.transaction(async (tx) => {
      if (ops.add && ops.add.length > 0) {
        await tx.add(ops.add);
      }
      if (ops.retract && ops.retract.length > 0) {
        await tx.retract(ops.retract);
      }
      return tx.getTransactionId();
    });
  }

  /**
   * Define an attribute schema
   * @param definition Attribute definition
   * @example
   * await db.defineAttribute({
   *   name: "email",
   *   type: "string",
   *   unique: true,
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
   * Query datoms from the database using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
   * @example
   * // Only query by filters to prevent accidental full table scan:
   * const datoms = await db.query({ attribute: "name", value: "Alice" });
   */
  async query(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
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
        throw new Error(
          "History query must include at least one filter or a limit to prevent full table scans"
        );
      }
      throw new Error(
        "Query must include at least one filter (entity, attribute, value, tx, asOf) or a limit to prevent full table scans"
      );
    }
    return this.executeQuery(options);
  }

  /**
   * Internal query method that bypasses validation
   * Used by datalog queries and transactions where validation is not needed
   * This is public to allow transaction implementations to access it, but should
   * not be used directly by external consumers - use query() instead
   * @param options Query options
   * @returns Array of matching datoms
   * @example
   * // Used internally in datalog or in transaction implementations:
   * await db.queryInternal({ entity: 42 });
   */
  async queryInternal(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    return this.executeQuery(options);
  }

  /**
   * Validate datoms against the current schema
   * @param datoms Array of datoms to validate
   * @param isAdd Whether these datoms are being added (true) or retracted (false)
   * @example
   * // Used internally before adding to enforce unique/cardinality constraints
   * await db.validateDatoms(addList, true);
   */
  protected async validateDatoms(
    datoms: DatomInput[],
    isAdd: boolean
  ): Promise<void> {
    for (const [entity, attribute, value] of datoms) {
      const definition = this.getAttributeDefinition(attribute as string);
      if (!definition) {
        // If no schema is defined, we allow any attribute but can't validate cardinality/uniqueness
        continue;
      }

      // If adding, check for cardinality: one
      if (isAdd && definition.cardinality === "one") {
        // Check if a value already exists for this entity/attribute
        // In a transaction, we'd need to check uncommitted changes too
        // For now, this is a basic check. Implementations can override for more complex validation.
        const existingValues = await this.getValues(
          entity,
          attribute as string
        );
        if (existingValues.length > 0) {
          // If we're adding a new value for a single-valued attribute,
          // the user should have retracted the old one first, or we could auto-retract.
          // Datomic usually auto-retracts for cardinality: one if you use entity maps,
          // but for raw datom adds it might require explicit retraction.
          // Let's be strict for now.
          throw new Error(
            `Attribute "${String(
              attribute
            )}" has cardinality: one, but entity "${String(
              entity
            )}" already has a value. Retract the existing value first.`
          );
        }
      }

      // Check uniqueness
      if (isAdd && definition.unique) {
        const existingDatoms = await this.query({
          attribute: attribute as string,
          value,
        });
        if (existingDatoms.length > 0) {
          const first = existingDatoms[0];
          if (first.entity !== entity) {
            throw new Error(
              `Attribute "${String(
                attribute
              )}" is unique, but value already exists for entity "${String(
                first.entity
              )}"`
            );
          }
        }
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
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found
   * @example
   * const value = await db.getValue(1, "name");
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
   * Query database state as it existed at a specific transaction ID (time-travel query)
   * @param tx Transaction ID to query at
   * @param options Additional query options
   * @returns Array of matching datoms at that point in time
   * @example
   * const old = await db.queryAsOf(55, { entity: 1 });
   */
  async queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]> {
    return this.query({ ...options, asOf: tx });
  }

  /**
   * Query full history of changes (all datoms matching filters, not just latest)
   * @param options Query options
   * @returns Array of all matching datoms ordered by transaction ID
   * @example
   * const history = await db.queryHistory({ entity: 1 });
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
   * @param callback Function that receives a transaction object
   * @returns The return value of the callback
   * @example
   * await db.transaction(async (tx) => {
   *   await tx.add([[101, "flag", true]]);
   *   const has = await tx.hasFact(101, "flag", true);
   *   // ...
   * });
   */
  abstract transaction<T>(
    callback: (tx: Transaction) => Promise<T>
  ): Promise<T>;

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
