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
   *
   * **Cardinality behavior:**
   * - For `cardinality: "one"` attributes: Returns the single value
   * - For `cardinality: "many"` attributes: Returns the value with the highest transaction ID (most recent)
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
    this.schema.set(name, updated);
    await this.onAttributeModified(name, existing, updated);
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
            throw typeError;
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
            throw new Error(
              `Attribute "${String(
                datom[1]
              )}" has cardinality: one, but multiple values provided for entity "${String(
                datom[0]
              )}" in the same transaction`
            );
          }
          entityAttributePairs.set(key, datom);
        }

        // Batch query for existing values
        for (const [key, datom] of entityAttributePairs) {
          const [entity, attribute] = key.split("|");
          const existingValues = await this.getValues(entity, attribute);
          if (existingValues.length > 0) {
            throw new Error(
              `Attribute "${String(
                attribute
              )}" has cardinality: one, but entity "${String(
                entity
              )}" already has a value. Retract the existing value first.`
            );
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
                throw new Error(
                  `Attribute "${String(
                    attrKey
                  )}" is unique, but value already exists for entity "${String(
                    existingEntity
                  )}"`
                );
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
        // EntityId can be number, string, or symbol
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
    // Execute all queries in parallel for better performance
    const results = await Promise.all(
      queries.map((q) => this.getValue(q.entity, q.attribute))
    );
    return results;
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
