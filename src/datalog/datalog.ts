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
export type QueryPattern = {
  e: DatalogQueryVariable | EntityId | '_';
  a: DatalogQueryVariable | Attribute | '_';
  v?: DatalogQueryVariable | Value | '_';
  tx?: DatalogQueryVariable | '_';
};

/**
 * Predicate expression (as tuples)
 */
export type QueryPredicate =
  | ['>', DatalogQueryVariable, number]
  | ['>=', DatalogQueryVariable, number]
  | ['<', DatalogQueryVariable, number]
  | ['=', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['!=', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['>=', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['<=', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['ground', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['get-else', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['missing?', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['tuple', DatalogQueryVariable, DatalogQueryVariable | Value]
  | ['untuple', DatalogQueryVariable, DatalogQueryVariable | Value];

/**
 * Or clause
 */
export type QueryOr = {
  or: QueryClause[];
};

/**
 * Not clause
 */
export type QueryNot = {
  not: QueryClause[];
};

/**
 * All possible query clauses
 */
export type QueryClause = QueryPattern | QueryOr | QueryNot;

/**
 * A parsed datalog query
 */
export interface DatalogQuery<
  TKey extends keyof Record<string, DatalogQueryFindVariable> = string,
> {
  /** Find clause - what variables to return */
  find: Record<TKey, DatalogQueryFindVariable>;
  /** Where clause - the query patterns */
  where: QueryClause[];
  /** Optional ordering */
  orderBy?: [variable: DatalogQueryVariable, direction: 'asc' | 'desc'][];
  /** Optional limit */
  limit?: number;
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
