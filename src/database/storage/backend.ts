/**
 * Storage backend abstraction for datoms persistence
 */

import type {
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
} from "../types.js";

/**
 * Interface that all storage backends must implement
 * This allows the database to work with any storage mechanism
 */
export interface StorageBackend {
  /**
   * Initialize the storage backend (create tables, indexes, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close the storage backend and clean up resources
   */
  close(): Promise<void>;

  /**
   * Get the next transaction ID
   */
  getNextTransactionId(): Promise<TransactionId>;

  /**
   * Add datoms to the database
   * @param datoms Array of datoms to add
   * @param tx Transaction ID
   */
  addDatoms(datoms: DatomInput[], tx: TransactionId): Promise<void>;

  /**
   * Retract datoms from the database
   * @param datoms Array of datoms to retract
   * @param tx Transaction ID
   */
  retractDatoms(datoms: DatomInput[], tx: TransactionId): Promise<void>;

  /**
   * Query datoms from the database
   * @param options Query options
   * @returns Array of matching datoms
   */
  queryDatoms(options: QueryOptions): Promise<Datom[]>;

  /**
   * Get all datoms for a specific entity
   * @param entity Entity ID
   * @returns Array of datoms for the entity
   */
  getEntityDatoms(entity: EntityId): Promise<Datom[]>;

  /**
   * Check if a backend supports transactions
   */
  supportsTransactions(): boolean;

  /**
   * Begin a transaction (if supported)
   */
  beginTransaction?(): Promise<void>;

  /**
   * Commit a transaction (if supported)
   */
  commitTransaction?(): Promise<void>;

  /**
   * Rollback a transaction (if supported)
   */
  rollbackTransaction?(): Promise<void>;
}
