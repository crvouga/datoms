/**
 * Datalog query
 */

import type {DatomDatabaseViewConfig} from './datom-database/datom-database-view-config.js';
import type {Attribute, Value} from './datoms.js';
import type {EntityId} from './entity-id.js';

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
export type DatalogQueryWhereClauseMatch = {
  t: 'match';
  e: DatalogQueryVariable | EntityId | '_';
  a: DatalogQueryVariable | Attribute | '_';
  v?: DatalogQueryVariable | Value | '_';
  tx?: DatalogQueryVariable | '_';
};

/**
 * Predicate expression (as tuples)
 */
export type DatalogQueryWhereClausePredicate =
  | {t: '>'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '>='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '<'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '!='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '>='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: '<='; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: 'ground'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: 'get-else'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: 'missing?'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: 'tuple'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number}
  | {t: 'untuple'; left: DatalogQueryVariable | number; right: DatalogQueryVariable | number};

/**
 * Or clause
 */
export type DatalogQueryWhereClauseOr = {
  t: 'or';
  clauses: DatalogQueryWhereClause[];
};

/**
 * Not clause
 */
export type DatalogQueryWhereClauseNot = {
  t: 'not';
  clauses: DatalogQueryWhereClause[];
};

/**
 * All possible query clauses
 */
export type DatalogQueryWhereClause =
  | DatalogQueryWhereClauseMatch
  | DatalogQueryWhereClausePredicate
  | DatalogQueryWhereClauseOr
  | DatalogQueryWhereClauseNot;

export type DatalogQueryOrderByClause =
  | {t: 'asc'; c: DatalogQueryVariable}
  | {t: 'desc'; c: DatalogQueryVariable};

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
  orderBy?: DatalogQueryOrderByClause[];
  /** Optional limit */
  limit?: number;
  /** Optional offset */
  offset?: number;
  /** Maximum number of results allowed (throws QueryResultSizeError if exceeded) */
  maxResultSize?: number;
  /** Optional context for the query */
  context?: Record<string, unknown>;
  /** Optional view configuration */
  viewConfig?: DatomDatabaseViewConfig;
}

/**
 * Check if a value is a variable (starts with ?)
 * @param value Value to check
 * @returns True if the value is a Datalog variable
 */
export function isVariable(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('?');
}

/**
 * Type guard to check if a QueryClause is a QueryPattern
 * @param clause Query clause to check
 * @returns True if the clause is a QueryPattern
 */
export function isQueryPattern(
  clause: DatalogQueryWhereClause,
): clause is DatalogQueryWhereClauseMatch {
  return clause.t === 'match';
}

/**
 * Strip the question mark prefix from a variable name
 * @param key Variable name (e.g., "?x" or "x")
 * @returns Variable name without the question mark prefix (e.g., "x")
 */
export function stripQuestionMark(key: string): string {
  return key.startsWith('?') ? key.slice(1) : key;
}
