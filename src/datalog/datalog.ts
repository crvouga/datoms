/**
 * Datalog query interface and parser
 */

import type {ViewConfig} from '../datom-database/views/view-config.js';
import type {Attribute, Value} from '../datoms.js';
import type {EntityId} from '../entity-id.js';

export type DatalogQueryVariable = `?${string}`;

export type DatalogQueryFindVariable =
  | [DatalogQueryVariable]
  | ['count', DatalogQueryVariable]
  | ['count-distinct', DatalogQueryVariable]
  | ['sum', DatalogQueryVariable]
  | ['avg', DatalogQueryVariable]
  | ['min', DatalogQueryVariable]
  | ['min', string | number, DatalogQueryVariable]
  | ['max', DatalogQueryVariable]
  | ['max', string | number, DatalogQueryVariable]
  | ['median', DatalogQueryVariable]
  | ['variance', DatalogQueryVariable]
  | ['stddev', DatalogQueryVariable]
  | ['rand', string | number, DatalogQueryVariable]
  | ['sample', string | number, DatalogQueryVariable]
  | ['distinct', DatalogQueryVariable];

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
  /** Optional context for the query */
  context?: Record<string, unknown>;
  /** Optional view configuration */
  viewConfig?: ViewConfig;
}

export const d: DatalogQuery = {
  find: {
    id: ['?e'],
    count: ['count', '?name'],
  },
  where: [{e: '?e', a: 'name', v: '?name'}],
};
