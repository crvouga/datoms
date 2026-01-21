/**
 * Temporary utility to convert DatomsQuery to DatalogQuery and convert results back to Datom[]
 * This is used during the migration from datoms() to query() and can be removed once migration is complete
 */

import type {
  DatalogQuery,
  DatalogQueryFindVariable,
  QueryClause,
  QueryPattern,
} from '../../datalog/datalog.js';
import type {Attribute, Datom, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {DatomsQuery, QueryResult} from '../views/database-view.js';

/**
 * Convert DatomsQuery to DatalogQuery
 * Creates a query that returns all datom fields (e, a, v, tx, op)
 * Note: op filtering is handled in post-processing since QueryPattern doesn't support op
 */
export function datomsQueryToDatalogQuery(options: DatomsQuery): DatalogQuery {
  // Note: Validation is performed during query execution, not during conversion
  // This allows queries to be constructed and passed around before execution
  const where: QueryClause[] = [];

  // Build the main query pattern
  const pattern: QueryPattern = {
    e: options.e !== undefined ? options.e : '?e',
    a: options.a !== undefined ? options.a : '?a',
    v: options.v !== undefined ? options.v : '?v',
  };

  // Add tx filter if specified
  if (options.tx !== undefined) {
    // TransactionId is a number, but QueryPattern.tx expects a variable or '_'
    // We'll use a predicate instead for exact match
    pattern.tx = '?tx';
    where.push(['=', '?tx', options.tx] as unknown as QueryClause);
  } else if (options.txMax !== undefined) {
    // For txMax, we need to use a predicate
    pattern.tx = '?tx';
    where.push(['<=', '?tx', options.txMax] as unknown as QueryClause);
  } else {
    pattern.tx = '?tx';
  }

  where.push(pattern);

  // Note: op filtering cannot be done in the where clause since QueryPattern doesn't support op
  // It will be handled in post-processing by queryResultsToDatoms

  const query: DatalogQuery = {
    find: {
      e: ['?e'],
      a: ['?a'],
      v: ['?v'],
      tx: ['?tx'],
      op: ['?op'],
    },
    where,
    limit: options.limit,
    maxResultSize: options.maxResultSize,
    context: options.context,
    viewConfig: options.viewConfig,
  };

  return query;
}

/**
 * Convert query results back to Datom[] format and apply op filter if specified
 * Assumes the query was created with datomsQueryToDatalogQuery which returns e, a, v, tx, op
 */
export function queryResultsToDatoms<TFind extends Record<string, DatalogQueryFindVariable>>(
  results: QueryResult<TFind>,
  options?: DatomsQuery,
): Datom[] {
  // Filter out results missing required fields before mapping
  let datoms = results
    .filter(result => {
      // e is required - filter out if missing
      return result.e != null;
    })
    .map(result => ({
      e: result.e as EntityId,
      a: result.a as Attribute,
      v: result.v as Value,
      tx: result.tx as TransactionId,
      // op defaults to true if not present (for backward compatibility)
      op: (result.op as boolean | undefined) ?? true,
    }));

  // Apply op filter if specified
  // When op is not specified, include both added and retracted datoms
  // This allows history queries to include retractions
  if (options?.op !== undefined) {
    datoms = datoms.filter(d => d.op === options.op);
  }
  // If op is not specified, don't filter - include all datoms

  return datoms;
}
