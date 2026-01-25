/**
 * Temporary utility to convert DatomsQuery to DatalogQuery and convert results back to Datom[]
 * This is used during the migration from datoms() to query() and can be removed once migration is complete
 */

import type {
  DatalogQuery,
  DatalogQueryFindVariable,
  DatalogQueryWhereClause,
  DatalogQueryWhereClauseMatch,
} from '../../datalog-query.js';
import type {Attribute, Datom, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {QueryResult} from '../views/database-view.js';
import type {DatomsQuery} from '../views/datoms-query.js';

/**
 * Convert DatomsQuery to DatalogQuery
 * Creates a query that returns all datom fields (e, a, v, tx, op)
 * Note: op filtering is handled in post-processing since QueryPattern doesn't support op
 */
export function datomsQueryToDatalogQuery(options: DatomsQuery): DatalogQuery {
  // Note: Validation is performed during query execution, not during conversion
  // This allows queries to be constructed and passed around before execution
  const where: DatalogQueryWhereClause[] = [];

  // Build the main query pattern
  const pattern: DatalogQueryWhereClauseMatch = {
    t: 'match',
    e: options.e !== undefined ? options.e : '?e',
    a: options.a !== undefined ? options.a : '?a',
    v: options.v !== undefined ? options.v : '?v',
  };

  // Add tx filter if specified
  if (options.tx !== undefined) {
    // TransactionId is a number, but QueryPattern.tx expects a variable or '_'
    // We'll use a predicate instead for exact match
    pattern.tx = '?tx';
    where.push(['=', '?tx', options.tx] as unknown as DatalogQueryWhereClause);
  } else if (options.txMax !== undefined) {
    // For txMax, we need to use a predicate
    pattern.tx = '?tx';
    where.push(['<=', '?tx', options.txMax] as unknown as DatalogQueryWhereClause);
  } else {
    pattern.tx = '?tx';
  }

  where.push(pattern);

  // Note: op filtering cannot be done in the where clause since QueryPattern doesn't support op
  // It will be handled in post-processing by queryResultsToDatoms

  const query: DatalogQuery = {
    find: {
      e: {t: 'identity', c: '?e'},
      a: {t: 'identity', c: '?a'},
      v: {t: 'identity', c: '?v'},
      tx: {t: 'identity', c: '?tx'},
      op: {t: 'identity', c: '?op'},
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
  // When pattern has literal values (e.g., e: 1), the query executor may not include
  // the variable in results, so we use the literal value from options as fallback
  let datoms = results
    .map(result => ({
      // Use literal value from options if result field is missing (happens when pattern has literal)
      e: (result.e as EntityId | undefined) ?? (options?.e as EntityId | undefined),
      a: (result.a as Attribute | undefined) ?? (options?.a as Attribute | undefined),
      v: (result.v as Value | undefined) ?? (options?.v as Value | undefined),
      tx: result.tx as TransactionId,
      // op defaults to true if not present (for backward compatibility)
      op: (result.op as boolean | undefined) ?? true,
    }))
    .filter(datom => {
      // e is required - filter out if still missing after fallback
      return datom.e != null;
    });

  // Apply op filter if specified
  // When op is not specified, include both added and retracted datoms
  // This allows history queries to include retractions
  if (options?.op !== undefined) {
    datoms = datoms.filter(d => d.op === options.op);
  }
  // If op is not specified, don't filter - include all datoms

  return datoms as Datom[];
}
