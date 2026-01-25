import type {
  DatalogQuery,
  DatalogQueryWhereClause,
  DatalogQueryWhereClauseMatch,
} from './datalog-query.js';
import {QuerySafetyError} from './datom-database/hook/hook.js';
import type {ViewConfig} from './datom-database/views/view-config.js';
import type {Attribute, TransactionId, Value} from './datoms.js';
import type {EntityId} from './entity-id.js';

export interface DatomsQuery {
  e?: EntityId;
  a?: Attribute;
  v?: Value;
  tx?: TransactionId;
  txMax?: TransactionId;
  op?: boolean;
  limit?: number;
  offset?: number;
  indexHint?: string | string[];
  timeoutMs?: number;
  maxResultSize?: number;
  context?: Record<string, unknown>;
  viewConfig?: ViewConfig;
}

/**
 * Validate that query has at least one filter or limit to prevent accidental full scans
 */
export function validateDatomsQuery(options: DatomsQuery): void {
  const hasFilter =
    options.e !== undefined ||
    options.a !== undefined ||
    options.v !== undefined ||
    options.tx !== undefined ||
    options.txMax !== undefined;
  const hasLimit = options.limit !== undefined;

  if (!hasFilter && !hasLimit) {
    throw new QuerySafetyError(
      'Query must include at least one filter (entity, attribute, value, tx, txMax) or a limit to prevent full table scans',
    );
  }
}

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
