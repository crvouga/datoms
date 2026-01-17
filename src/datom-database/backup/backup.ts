/**
 * Backup and restore utilities for DatomDatabase
 * Provides export and import functionality for datoms
 */

import type { DatomDatabase } from "../datom-database.js";
import type { Datom, DatomInput, QueryOptions } from "../../types.js";

/**
 * Export all datoms from the database as an async iterable
 * Useful for backup, replication, and migration scenarios
 *
 * **Note:** This method bypasses query safety checks and can perform full table scans.
 * Use filters in options to limit the export scope when possible.
 *
 * @param db Database instance
 * @param options Optional export options (filters are recommended but not required)
 * @returns Async iterable of datoms
 * @example
 * // Stream all datoms to a file (full export)
 * const stream = exportDatoms(db);
 * for await (const datom of stream) {
 *   await writeDatomToFile(datom);
 * }
 *
 * // Export with filters (recommended for large databases)
 * const filtered = exportDatoms(db, { attribute: "status" });
 * for await (const datom of filtered) {
 *   // Process datom
 * }
 */
export async function* exportDatoms(
  db: DatomDatabase,
  options?: QueryOptions
): AsyncIterable<Datom> {
  await db.initialize();
  // Use queryInternal to bypass safety checks for export (explicit operation)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const datoms = await (db as any).queryInternal(options || {});
  for (const datom of datoms) {
    yield datom;
  }
}

/**
 * Import datoms into the database from an async iterable
 * Useful for restore, replication, and migration scenarios
 *
 * @param db Database instance
 * @param source Async iterable of datoms to import
 * @param options Optional import options
 * @returns Number of datoms imported
 * @example
 * // Import from a file
 * const datoms = readDatomsFromFile();
 * const count = await importDatoms(db, datoms);
 * console.log(`Imported ${count} datoms`);
 */
export async function importDatoms(
  db: DatomDatabase,
  source: AsyncIterable<Datom>,
  options?: { batchSize?: number; validate?: boolean }
): Promise<number> {
  await db.initialize();
  const batchSize = options?.batchSize ?? 1000;
  const validate = options?.validate ?? true;
  let datomCount = 0;
  let batch: DatomInput[] = [];
  let batchAdded: boolean[] = []; // Track which datoms in batch are added vs retracted

  for await (const datom of source) {
    // Convert Datom to DatomInput
    batch.push([datom[0], datom[1], datom[2]]);
    batchAdded.push(datom[4]);

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
      const dedupeAdded = deduplicateBatch(addedBatch);
      const dedupeRetracted = deduplicateBatch(retractedBatch);

      if (validate) {
        if (dedupeAdded.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await (db as any).validateDatoms(dedupeAdded, true);
        }
        if (dedupeRetracted.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await (db as any).validateDatoms(dedupeRetracted, false);
        }
      }

      // Filter out datoms that already exist with the same value (idempotent import)
      const filteredAdded = await filterExistingDatoms(db, dedupeAdded);
      const filteredRetracted = await filterExistingDatoms(db, dedupeRetracted);

      if (filteredAdded.length > 0) {
        await db.transact({ add: filteredAdded });
      }
      if (filteredRetracted.length > 0) {
        await db.transact({ retract: filteredRetracted });
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
    const dedupeAdded = deduplicateBatch(addedBatch);
    const dedupeRetracted = deduplicateBatch(retractedBatch);

    if (validate) {
      if (dedupeAdded.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (db as any).validateDatoms(dedupeAdded, true);
      }
      if (dedupeRetracted.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (db as any).validateDatoms(dedupeRetracted, false);
      }
    }

    // Filter out datoms that already exist with the same value (idempotent import)
    const filteredAdded = await filterExistingDatoms(db, dedupeAdded);
    const filteredRetracted = await filterExistingDatoms(db, dedupeRetracted);

    if (filteredAdded.length > 0) {
      await db.transact({ add: filteredAdded });
    }
    if (filteredRetracted.length > 0) {
      await db.transact({ retract: filteredRetracted });
    }
    datomCount += batch.length;
  }

  return datomCount;
}

/**
 * Deduplicate a batch of datoms, keeping only the latest occurrence of each (entity, attribute, value) pair.
 */
function deduplicateBatch(batch: DatomInput[]): DatomInput[] {
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
    const deduplicatedChunks = chunks.map((chunk) => deduplicateBatch(chunk));
    // Final deduplication pass on merged chunks
    return deduplicateBatch(deduplicatedChunks.flat());
  }

  // Single-pass Map accumulation for O(n) complexity
  const seen = new Map<string, DatomInput>();
  for (const datom of batch) {
    // Use a key that handles Date objects and other types correctly
    const valueKey = getValueKey(datom[2]);
    const key = `${String(datom[0])}|${String(datom[1])}|${valueKey}`;
    seen.set(key, datom); // Later occurrences overwrite earlier ones
  }
  return Array.from(seen.values());
}

/**
 * Generate a consistent key for a value, handling Date objects and other special types.
 */
function getValueKey(value: unknown): string {
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
 */
async function filterExistingDatoms(
  db: DatomDatabase,
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

    // Get all values for each entity-attribute pair
    const existingValuesBatch: unknown[][] = [];
    for (const q of queries) {
      const datoms = await db.datoms({
        entity: q.entity,
        attribute: q.attribute,
      });
      existingValuesBatch.push(datoms.map((d) => d[2]));
    }

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
          valueSet.add(getValueKey(val));
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
      if (!existingValueSet || !existingValueSet.has(getValueKey(value))) {
        filtered.push(chunk[i]);
      }
      // If value matches, skip (idempotent)
    }
  }

  return filtered;
}
