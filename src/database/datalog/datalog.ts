/**
 * Datalog query interface and parser
 */

import type { Database } from "../database.js";
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

/**
 * Simple datalog query executor
 */
export class DatalogQueryEngine {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Execute a parsed datalog query
   */
  async execute(query: DatalogQuery): Promise<QueryResult> {
    // Simple implementation: for each where clause, query the database
    // and join the results
    if (query.where.length === 0) {
      return [];
    }

    // Start with the first clause
    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause);

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause);
      results = this.joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    // Project to find variables
    const projected = this.project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const aVal = a[variable];
          const bVal = b[variable];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          // Handle symbol comparison
          if (typeof aVal === "symbol" || typeof bVal === "symbol") {
            const aStr = String(aVal);
            const bStr = String(bVal);
            if (aStr < bStr) return direction === "asc" ? -1 : 1;
            if (aStr > bStr) return direction === "asc" ? 1 : -1;
          } else {
            if (aVal < bVal) return direction === "asc" ? -1 : 1;
            if (aVal > bVal) return direction === "asc" ? 1 : -1;
          }
        }
        return 0;
      });
    }

    // Apply limit
    if (query.limit) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  /**
   * Execute a single query clause
   */
  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value>[]> {
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = this.isVariable(entityVal)
      ? undefined
      : (entityVal as EntityId);
    const attribute = this.isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = this.isVariable(valueVal) ? undefined : (valueVal as Value);

    const datoms = await this.db.query({
      entity,
      attribute,
      value,
    });

    // Map datom fields to variable names from the clause
    return datoms.map((datom) => {
      const result: Record<string, Value> = {};
      if (this.isVariable(entityVal)) {
        result[entityVal as string] = datom.entity;
      }
      if (this.isVariable(attributeVal)) {
        result[attributeVal as string] = datom.attribute;
      }
      if (this.isVariable(valueVal)) {
        result[valueVal as string] = datom.value;
      }
      return result;
    });
  }

  /**
   * Join two result sets based on common variables
   */
  private joinResults(
    left: Record<string, Value>[],
    right: Record<string, Value>[],
    clauses: QueryClause[]
  ): Record<string, Value>[] {
    const joined: Record<string, Value>[] = [];

    for (const leftRow of left) {
      for (const rightRow of right) {
        // Check if rows are compatible (same values for common variables)
        let compatible = true;
        for (const key of Object.keys(leftRow)) {
          if (key in rightRow && leftRow[key] !== rightRow[key]) {
            compatible = false;
            break;
          }
        }

        if (compatible) {
          joined.push({ ...leftRow, ...rightRow });
        }
      }
    }

    return joined;
  }

  /**
   * Project results to only include find variables
   */
  private project(
    results: Record<string, Value>[],
    find: string[],
    clauses: QueryClause[]
  ): QueryResult {
    if (find.length === 0) {
      return results;
    }

    // Results already have variable names as keys, so just extract the find variables
    return results.map((row) => {
      const projected: Record<string, Value> = {};
      for (const varName of find) {
        if (varName in row) {
          projected[varName] = row[varName];
        }
      }
      return projected;
    });
  }

  /**
   * Check if a value is a variable (starts with ?)
   */
  private isVariable(value: any): boolean {
    return typeof value === "string" && value.startsWith("?");
  }

  /**
   * Execute a datalog query
   */
  async query(query: DatalogQuery): Promise<QueryResult> {
    return this.execute(query);
  }
}
