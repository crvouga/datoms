/**
 * Datalog query interface and parser
 */

import type {ViewConfig} from '../datom-database/views/view-config.js';
import type {Attribute, Value} from '../datoms.js';
import type {EntityId} from '../entity-id.js';

export type DatalogQueryVariable = `?${string}`;

export type DatalogQueryFindVariable =
  | {t: 'identity'; c: DatalogQueryVariable}
  | {t: 'count'; c: DatalogQueryVariable}
  | {t: 'count-distinct'; c: DatalogQueryVariable}
  | {t: 'sum'; c: DatalogQueryVariable}
  | {t: 'avg'; c: DatalogQueryVariable}
  | {t: 'min'; c: DatalogQueryVariable; count: number}
  | {t: 'max'; c: DatalogQueryVariable; count: number}
  | {t: 'median'; c: DatalogQueryVariable}
  | {t: 'variance'; c: DatalogQueryVariable}
  | {t: 'stddev'; c: DatalogQueryVariable}
  | {t: 'rand'; c: DatalogQueryVariable; count: number}
  | {t: 'sample'; c: DatalogQueryVariable; count: number}
  | {t: 'distinct'; c: DatalogQueryVariable};

/**
 * Basic query pattern
 */
export type DatalogQueryWherePattern = {
  e: DatalogQueryVariable | EntityId | '_';
  a: DatalogQueryVariable | Attribute | '_';
  v?: DatalogQueryVariable | Value | '_';
  tx?: DatalogQueryVariable | '_';
};

/**
 * Predicate expression (as tuples)
 */
export type QueryPredicate =
  | {t: '>'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '>='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '<'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '!='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '>='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '<='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number};
// | {t: 'ground', left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
// | {t: 'get-else', left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
// | {t: 'missing?', left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
// | {t: 'tuple', left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
// | {t: 'untuple', left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}

/**
 * Or clause
 */
export type QueryOr = {
  or: DatalogQueryWhereClause[];
};

/**
 * Not clause
 */
export type QueryNot = {
  not: DatalogQueryWhereClause[];
};

/**
 * All possible query clauses
 */
export type DatalogQueryWhereClause = DatalogQueryWherePattern | QueryOr | QueryNot;

/**
 * A parsed datalog query
 */
export interface DatalogQuery<
  TKey extends keyof Record<string, DatalogQueryFindVariable> = string,
> {
  /** Find clause - what variables to return */
  find: Record<TKey, DatalogQueryFindVariable>;
  /** Where clause - the query patterns */
  where: DatalogQueryWhereClause[];
  /** Optional ordering */
  orderBy?: [variable: DatalogQueryVariable, direction: 'asc' | 'desc'][];
  /** Optional limit */
  limit?: number;
  /** Optional offset */
  offset?: number;
  /** Maximum number of results allowed (throws QueryResultSizeError if exceeded) */
  maxResultSize?: number;
  /** Optional context for the query */
  context?: Record<string, unknown>;
  /** Optional view configuration */
  viewConfig?: ViewConfig;
}

export function datalog<TKey extends keyof Record<string, DatalogQueryFindVariable> = string>(
  query: DatalogQuery<TKey>,
): DatalogQuery<TKey> {
  return query;
}
