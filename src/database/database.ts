/**
 * Main database interface for working with datoms
 */

import type {
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "./types.js";
import type { StorageBackend } from "./storage/backend.js";

/**
 * Main database class that provides a high-level interface
 * for working with datoms and datalog queries
 */
export class Database {
  private backend: StorageBackend;
  private initialized = false;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /**
   * Initialize the database and storage backend
   */
  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.backend.initialize();
      this.initialized = true;
    }
  }

  /**
   * Close the database and clean up resources
   */
  async close(): Promise<void> {
    await this.backend.close();
    this.initialized = false;
  }

  /**
   * Add datoms to the database
   * @param datoms Array of datoms to add
   * @returns The transaction ID
   */
  async add(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = await this.backend.getNextTransactionId();

    if (this.backend.supportsTransactions() && this.backend.beginTransaction) {
      await this.backend.beginTransaction();
      try {
        await this.backend.addDatoms(datoms, tx);
        if (this.backend.commitTransaction) {
          await this.backend.commitTransaction();
        }
      } catch (error) {
        if (this.backend.rollbackTransaction) {
          await this.backend.rollbackTransaction();
        }
        throw error;
      }
    } else {
      await this.backend.addDatoms(datoms, tx);
    }

    return tx;
  }

  /**
   * Retract datoms from the database
   * @param datoms Array of datoms to retract
   * @returns The transaction ID
   */
  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = await this.backend.getNextTransactionId();

    if (this.backend.supportsTransactions() && this.backend.beginTransaction) {
      await this.backend.beginTransaction();
      try {
        await this.backend.retractDatoms(datoms, tx);
        if (this.backend.commitTransaction) {
          await this.backend.commitTransaction();
        }
      } catch (error) {
        if (this.backend.rollbackTransaction) {
          await this.backend.rollbackTransaction();
        }
        throw error;
      }
    } else {
      await this.backend.retractDatoms(datoms, tx);
    }

    return tx;
  }

  /**
   * Query datoms from the database
   * @param options Query options
   * @returns Array of matching datoms
   */
  async query(options: QueryOptions = {}): Promise<Datom[]> {
    await this.ensureInitialized();
    return this.backend.queryDatoms(options);
  }

  /**
   * Get all datoms for a specific entity
   * @param entity Entity ID
   * @returns Array of datoms for the entity
   */
  async getEntity(entity: EntityId): Promise<Datom[]> {
    await this.ensureInitialized();
    return this.backend.getEntityDatoms(entity);
  }

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
   * Ensure the database is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
