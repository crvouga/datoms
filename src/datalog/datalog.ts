/**
 * Datalog query interface and parser
 */

import type { Attribute, EntityId, Value } from "../types.js";

export type DatalogQueryVariable = `?${string}`;

export type DatalogQueryFindVariable =
  | [DatalogQueryVariable]
  | ["count", DatalogQueryVariable]
  | ["count-distinct", DatalogQueryVariable]
  | ["sum", DatalogQueryVariable]
  | ["avg", DatalogQueryVariable]
  | ["min", DatalogQueryVariable]
  | ["min", string | number, DatalogQueryVariable]
  | ["max", DatalogQueryVariable]
  | ["max", string | number, DatalogQueryVariable]
  | ["median", DatalogQueryVariable]
  | ["variance", DatalogQueryVariable]
  | ["stddev", DatalogQueryVariable]
  | ["rand", string | number, DatalogQueryVariable]
  | ["sample", string | number, DatalogQueryVariable]
  | ["distinct", DatalogQueryVariable];

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
 * Predicate expression (as tuples)
 */
export type QueryPredicate =
  | [">", DatalogQueryVariable, number]
  | [">=", DatalogQueryVariable, number]
  | ["<", DatalogQueryVariable, number]
  | ["=", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["!=", DatalogQueryVariable, DatalogQueryVariable | Value]
  | [">=", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["<=", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["ground", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["get-else", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["missing?", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["tuple", DatalogQueryVariable, DatalogQueryVariable | Value]
  | ["untuple", DatalogQueryVariable, DatalogQueryVariable | Value];

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
  find: Record<string, DatalogQueryFindVariable>;
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
    id: ["?e"],
    count: ["count", "?name"],
  },
  where: [{ e: "?e", a: "name", v: "?name" }],
};
