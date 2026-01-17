/**
 * Datalog query interface and parser
 */

import type { Attribute, EntityId, Value } from "../types.js";

export type DatalogQueryVariable = `?${string}`;

export type DatalogQueryAggregationVariable =
  | `count(?${string})`
  | `count-distinct(?${string})`
  | `sum(?${string})`
  | `avg(?${string})`
  | `min(?${string})`
  | `max(?${string})`
  | `median(?${string})`
  | `variance(?${string})`
  | `stddev(?${string})`
  | `rand(${string}, ?${string})`
  | `sample(${string}, ?${string})`
  | `distinct(?${string})`
  | `min(${string}, ?${string})`
  | `max(${string}, ?${string})`;

/**
 * Basic query pattern
 */
export type QueryPattern = {
  e: DatalogQueryVariable | EntityId | "_";
  a: DatalogQueryVariable | Attribute | "_";
  v?: DatalogQueryVariable | Value | "_";
  tx?: DatalogQueryVariable | "_";
};

/**
 * Predicate expression
 */
export type QueryPredicate =
  | `> ${number} ?${string}`
  | `>= ?${string} ${number}`
  | `< ${number} ?${string}`
  | `= ?${string} ${string}`
  | `!= ?${string} ${string}`
  | `>= ?${string} ${string}`
  | `<= ?${string} ${string}`
  | `ground ?${string} ${string}`
  | `get-else ?${string} ${string}`
  | `missing? ?${string} ${string}`
  | `tuple ?${string} ${string}`
  | `untuple ?${string} ${string}`;

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
export interface DatalogQuery {
  /** Find clause - what variables to return */
  find: Record<string, DatalogQueryVariable | DatalogQueryAggregationVariable>;
  /** Where clause - the query patterns */
  where: QueryClause[];
  /** Optional ordering */
  orderBy?: [variable: DatalogQueryVariable, direction: "asc" | "desc"][];
  /** Optional limit */
  limit?: number;
}

/**
 * Result of a datalog query execution
 */
export type QueryResult = Array<Record<string, Value | Attribute | EntityId>>;

export const d: DatalogQuery = {
  find: {
    id: "?e",
    count: "count(?name)",
  },
  where: [{ e: "?e", a: "name", v: "?name" }],
};
