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
   */
  query(options: QueryOptions): Promise<Datom[]>;

  /**
   * Query database state as it existed at a specific transaction ID (time-travel query)
   * @param tx Transaction ID to query at
   * @param options Additional query options
   * @returns Array of matching datoms at that point in time
   */
  queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query
   * @param query Datalog query to execute
   * @returns Query results as an array of records
   */
  queryDatalog(query: DatalogQuery): Promise<QueryResult>;

  /**
   * Get all datoms for a specific entity
   * @param entity Entity ID
   * @returns Array of datoms for the entity
   */
  getEntity(entity: EntityId): Promise<Datom[]>;

  /**
   * Get a single value for an entity-attribute pair
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found
   */
  getValue(entity: EntityId, attribute: string): Promise<Value | undefined>;

  /**
   * Get all values for an entity-attribute pair
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns Array of values
   */
  getValues(entity: EntityId, attribute: string): Promise<Value[]>;

  /**
   * Check if a fact exists
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param value Value to check
   * @returns True if the fact exists
   */
  hasFact(entity: EntityId, attribute: string, value: Value): Promise<boolean>;
}

/**
 * Shared interface for writing datoms
 */
export interface DatomWriter {
  /**
   * Add datoms to the database
   * @param datoms Array of datoms to add
   * @returns The transaction ID (void for transactions)
   */
  add(datoms: DatomInput[]): Promise<TransactionId | void>;

  /**
   * Retract datoms from the database
   * @param datoms Array of datoms to retract
   * @returns The transaction ID (void for transactions)
   */
  retract(datoms: DatomInput[]): Promise<TransactionId | void>;

  /**
   * Retract all datoms for a specific entity
   * @param entity Entity ID
   * @returns The transaction ID (void for transactions)
   */
  retractEntity(entity: EntityId): Promise<TransactionId | void>;

  /**
   * Execute bulk operations atomically
   * @param ops Object containing add and/or retract arrays
   * @returns The transaction ID (void for transactions)
   */
  transact(ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }): Promise<TransactionId | void>;
}

/**
 * Transaction interface that exposes all database operations
 * scoped to a transaction. Queries within a transaction see
 * uncommitted changes from earlier operations in the same transaction.
 */
export interface Transaction extends DatomReader, DatomWriter {}

/**
 * Abstract datom database class that provides a high-level interface
 * for working with datoms and datalog queries
 * Concrete implementations: InMemoryDatabase, SQLiteDatabase, PostgreSQLDatabase
 */
export abstract class DatomDatabase implements DatomReader, DatomWriter {
  protected initialized = false;
  protected schema: Map<string, AttributeDefinition> = new Map();

  /**
   * Initialize the database
   */
  abstract initialize(): Promise<void>;

  /**
   * Close the database and clean up resources
   */
  abstract close(): Promise<void>;

  /**
   * Add datoms to the database
   * @param datoms Array of datoms to add
   * @returns The transaction ID
   */
  abstract add(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Retract datoms from the database
   * @param datoms Array of datoms to retract
   * @returns The transaction ID
   */
  abstract retract(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Retract all datoms for a specific entity
   * @param entity Entity ID
   * @returns The transaction ID
   */
  abstract retractEntity(entity: EntityId): Promise<TransactionId>;

  /**
   * Execute bulk operations atomically
   * @param ops Object containing add and/or retract arrays
   * @returns The transaction ID
   */
  async transact(ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }): Promise<TransactionId> {
    await this.ensureInitialized();
    // Use a transaction to ensure atomicity
    // We'll execute the operations and capture the transaction ID
    let txId: TransactionId | undefined;
    await this.transaction(async (tx) => {
      if (ops.add && ops.add.length > 0) {
        await tx.add(ops.add);
      }
      if (ops.retract && ops.retract.length > 0) {
        await tx.retract(ops.retract);
      }
      // Access transaction ID from implementation
      // This is a bit of a hack, but necessary since Transaction interface doesn't expose txId
      txId = (tx as any).txId;
      return undefined; // Return value doesn't matter
    });
    if (txId === undefined) {
      throw new Error("Transaction ID not available");
    }
    return txId;
  }

  /**
   * Define an attribute schema
   * @param definition Attribute definition
   */
  async defineAttribute(definition: AttributeDefinition): Promise<void> {
    await this.ensureInitialized();
    this.schema.set(definition.name, definition);
    await this.onAttributeDefined(definition);
  }

  /**
   * Hook for implementations to handle attribute definition
   * (e.g., create indexes)
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
   */
  getAttributeDefinition(name: string): AttributeDefinition | undefined {
    return this.schema.get(name);
  }

  /**
   * Query datoms from the database using query options
   * @param options Query options (must include at least one filter or limit to prevent full scans)
   * @returns Array of matching datoms
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

    if (!hasFilter && !hasLimit && !isHistory) {
      throw new Error(
        "Query must include at least one filter (entity, attribute, value, tx, asOf), a limit, or history: true to prevent full table scans"
      );
    }
    return this.executeQuery(options);
  }

  /**
   * Execute the actual query (implemented by subclasses)
   */
  protected abstract executeQuery(options: QueryOptions): Promise<Datom[]>;

  /**
   * Execute a datalog query
   * @param query Datalog query to execute
   * @returns Query results as an array of records
   */
  abstract queryDatalog(query: DatalogQuery): Promise<QueryResult>;

  /**
   * Get all datoms for a specific entity
   * @param entity Entity ID
   * @returns Array of datoms for the entity
   */
  abstract getEntity(entity: EntityId): Promise<Datom[]>;

  /**
   * Get a single value for an entity-attribute pair
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found
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
   */
  async queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]> {
    return this.query({ ...options, asOf: tx });
  }

  /**
   * Query full history of changes (all datoms matching filters, not just latest)
   * @param options Query options
   * @returns Array of all matching datoms ordered by transaction ID
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
   */
  abstract transaction<T>(
    callback: (tx: Transaction) => Promise<T>
  ): Promise<T>;

  /**
   * Ensure the database is initialized
   */
  protected async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
