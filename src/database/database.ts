/**
 * Abstract database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { DatalogQuery, QueryResult } from "./datalog.js";
import type {
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";

/**
 * Transaction interface that exposes all database operations
 * scoped to a transaction. Queries within a transaction see
 * uncommitted changes from earlier operations in the same transaction.
 */
export interface Transaction {
  /**
   * Query datoms from the database using query options
   * @param options Query options
   * @returns Array of matching datoms (includes uncommitted changes)
   */
  query(options?: QueryOptions): Promise<Datom[]>;

  /**
   * Add datoms to the database within this transaction
   * @param datoms Array of datoms to add
   * @returns The transaction ID
   */
  add(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Retract datoms from the database within this transaction
   * @param datoms Array of datoms to retract
   * @returns The transaction ID
   */
  retract(datoms: DatomInput[]): Promise<TransactionId>;

  /**
   * Execute a datalog query within this transaction
   * @param query Datalog query to execute
   * @returns Query results as an array of records (includes uncommitted changes)
   */
  queryDatalog(query: DatalogQuery): Promise<QueryResult>;

  /**
   * Get all datoms for a specific entity within this transaction
   * @param entity Entity ID
   * @returns Array of datoms for the entity (includes uncommitted changes)
   */
  getEntity(entity: EntityId): Promise<Datom[]>;

  /**
   * Get a single value for an entity-attribute pair within this transaction
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns The value or undefined if not found
   */
  getValue(entity: EntityId, attribute: string): Promise<Value | undefined>;

  /**
   * Get all values for an entity-attribute pair within this transaction
   * @param entity Entity ID
   * @param attribute Attribute name
   * @returns Array of values
   */
  getValues(entity: EntityId, attribute: string): Promise<Value[]>;

  /**
   * Check if a fact exists within this transaction
   * @param entity Entity ID
   * @param attribute Attribute name
   * @param value Value to check
   * @returns True if the fact exists
   */
  hasFact(entity: EntityId, attribute: string, value: Value): Promise<boolean>;
}

/**
 * Abstract database class that provides a high-level interface
 * for working with datoms and datalog queries
 * Concrete implementations: InMemoryDatabase, SqlDatabase
 */
export abstract class Database {
  protected initialized = false;

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
   * Query datoms from the database using query options
   * @param options Query options
   * @returns Array of matching datoms
   */
  abstract query(options?: QueryOptions): Promise<Datom[]>;

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
    const datoms = await this.query({ entity, attribute });
    return datoms.length > 0 ? datoms[0].value : undefined;
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
