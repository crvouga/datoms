/**
 * In-memory storage backend implementation
 */

import type {
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
} from "../types.js";
import type { StorageBackend } from "./backend.js";

/**
 * In-memory storage backend using a Map-based structure
 * Useful for testing and small datasets
 */
export class MemoryBackend implements StorageBackend {
  private datoms: Datom[] = [];
  private nextTx: TransactionId = 1;
  private inTransaction = false;

  async initialize(): Promise<void> {
    this.datoms = [];
    this.nextTx = 1;
  }

  async close(): Promise<void> {
    this.datoms = [];
  }

  async getNextTransactionId(): Promise<TransactionId> {
    return this.nextTx++;
  }

  async addDatoms(datoms: DatomInput[], tx: TransactionId): Promise<void> {
    for (const datom of datoms) {
      this.datoms.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx,
        added: true,
      });
    }
  }

  async retractDatoms(datoms: DatomInput[], tx: TransactionId): Promise<void> {
    for (const datom of datoms) {
      // Add retraction datom
      this.datoms.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx,
        added: false,
      });
    }
  }

  async queryDatoms(options: QueryOptions): Promise<Datom[]> {
    let results = this.datoms;

    // Apply filters
    if (options.entity !== undefined) {
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Handle retractions: for each unique (entity, attribute, value) combination,
    // keep only the most recent transaction
    // This ensures that retracted datoms are not returned when querying
    if (options.added === undefined || options.added === true) {
      // Group by (entity, attribute, value) and keep only the most recent transaction
      const latestDatoms = new Map<string, Datom>();
      for (const datom of results) {
        const key = `${String(datom.entity)}|${String(
          datom.attribute
        )}|${String(datom.value)}`;
        const existing = latestDatoms.get(key);
        if (!existing || datom.tx > existing.tx) {
          latestDatoms.set(key, datom);
        }
      }
      results = Array.from(latestDatoms.values());

      // Filter to only added datoms (default behavior)
      results = results.filter((d) => d.added);
    } else if (options.added === false) {
      // If explicitly requesting retractions, filter by added: false
      results = results.filter((d) => !d.added);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    const paginated = results.slice(offset, limit ? offset + limit : undefined);

    return paginated;
  }

  async getEntityDatoms(entity: EntityId): Promise<Datom[]> {
    return this.queryDatoms({ entity, added: true });
  }

  supportsTransactions(): boolean {
    return false; // Simple in-memory doesn't need transactions
  }
}
