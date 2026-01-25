/**
 * Shared query execution logic for in-memory datom arrays
 * Extracted to avoid circular dependencies between InMemoryDatomDatabase and SpeculativeDatabaseView
 */

import type {Datom} from '../../datoms.js';
import type {DatomsQuery} from '../views/datoms-query.js';

/**
 * Execute a query on an array of datoms
 * Filters, deduplicates, and paginates results according to query options
 */
export function executeQueryOnDatoms(datoms: Datom[], options: DatomsQuery): Datom[] {
  // Validate that tx and txMax are mutually exclusive
  if (options.tx !== undefined && options.txMax !== undefined) {
    throw new Error('Cannot specify both tx and txMax parameters - they are mutually exclusive');
  }

  let results = datoms;

  // Apply filters
  if (options.e !== undefined) {
    results = results.filter(d => d.e === options.e);
  }
  if (options.a !== undefined) {
    results = results.filter(d => d.a === options.a);
  }
  if (options.v !== undefined) {
    results = results.filter(d => d.v === options.v);
  }
  if (options.tx !== undefined) {
    results = results.filter(d => d.tx === options.tx);
  }
  if (options.txMax !== undefined) {
    const txMax = options.txMax;
    results = results.filter(d => d.tx <= txMax);
  }

  // Handle retractions: for each unique (entity, attribute, value) combination,
  // keep only the most recent transaction
  // This ensures that sub datoms are not returned when querying
  // and supports multi-valued attributes (multiple values per attribute)
  // Always deduplicate first, then apply add filter

  // Normal query: deduplicate and filter
  // Deduplicate by (entity, attribute, value) to support multi-valued attributes
  const latestDatoms = new Map<string, Datom>();
  for (const datom of results) {
    // Use (entity, attribute, value) key for regular queries to support multi-valued attributes
    const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
    const existing = latestDatoms.get(key);
    if (!existing || datom.tx > existing.tx) {
      latestDatoms.set(key, datom);
    }
  }
  results = Array.from(latestDatoms.values());

  // Apply op filter after deduplication
  // Default behavior: filter to only added datoms (exclude subed)
  if (options.op === undefined || options.op === true) {
    results = results.filter(d => d.op === true);
  } else if (options.op === false) {
    // If explicitly requesting retractions, filter by op: false
    results = results.filter(d => d.op === false);
  }

  // Apply pagination
  const offset = options.offset ?? 0;
  const limit = options.limit;
  const paginated = results.slice(offset, limit ? offset + limit : undefined);

  return paginated;
}
