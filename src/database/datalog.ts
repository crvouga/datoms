/**
 * Datalog query interface and parser
 */

import type { EntityId, Value } from "../types.js";

/**
 * A datalog query clause
 * Tuple format: [entity, attribute, value]
 */
export type QueryClause = [
  entity: string | EntityId,
  attribute: string,
  value: string | Value
];

/**
 * A parsed datalog query
 */
export interface DatalogQuery {
  /** Find clause - what variables to return */
  find: string[];
  /** Where clause - the query patterns */
  where: QueryClause[];
  /** Optional ordering */
  orderBy?: [variable: string, direction: "asc" | "desc"][];
  /** Optional limit */
  limit?: number;
}

/**
 * Result of a datalog query execution
 */
export type QueryResult = Record<string, Value>[];
