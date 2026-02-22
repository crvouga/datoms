/**
 * Temporary utility to convert DatomsQuery to DatalogQuery and convert results back to Datom[]
 * This is used during the migration from datoms() to query() and can be removed once migration is complete
 */

import type {DatalogQueryFindVariable} from '../../datalog-query.js';
import type {DatomsQuery} from '../../datoms-query.js';
import type {Attribute, Datom, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {QueryResult} from '../datom-database-view.js';

/**
 * Convert query results back to Datom[] format and apply op filter if specified
 * Assumes the query was created with datomsQueryToDatalogQuery which returns e, a, v, tx, op
 */
export function queryResultsToDatoms<TFind extends Record<string, DatalogQueryFindVariable>>(
  results: QueryResult<TFind>,
  options?: DatomsQuery,
): Datom[] {
  // Filter out results missing required fields before mapping
  // When pattern has literal values (e.g., e: 1), the query executor may not include
  // the variable in results, so we use the literal value from options as fallback
  let datoms = results
    .map((result) => ({
      // Use literal value from options if result field is missing (happens when pattern has literal)
      e: (result.e as EntityId | undefined) ?? (options?.e as EntityId | undefined),
      a: (result.a as Attribute | undefined) ?? (options?.a as Attribute | undefined),
      v: (result.v as Value | undefined) ?? (options?.v as Value | undefined),
      tx: result.tx as TransactionId,
      // op defaults to true if not present (for backward compatibility)
      op: (result.op as boolean | undefined) ?? true,
    }))
    .filter((datom) => {
      // e is required - filter out if still missing after fallback
      return datom.e != null;
    });

  // Apply op filter if specified
  // When op is not specified, include both added and retracted datoms
  // This allows history queries to include retractions
  if (options?.op !== undefined) {
    datoms = datoms.filter((d) => d.op === options.op);
  }
  // If op is not specified, don't filter - include all datoms

  return datoms as Datom[];
}
