/**
 * Datalog query interface and parser
 */

import type { Database } from "./database.js";
import type { EntityId, Value } from "./types.js";

/**
 * A datalog query clause
 */
export interface QueryClause {
  /** Variable name or entity ID */
  entity: string | EntityId;
  /** Attribute name */
  attribute: string;
  /** Value, variable name, or constant */
  value: string | Value;
  /** Whether this is a variable (starts with ?) */
  isVariable?: boolean;
}

/**
 * A parsed datalog query
 */
export interface DatalogQuery {
  /** Find clause - what variables to return */
  find: string[];
  /** Where clause - the query patterns */
  where: QueryClause[];
  /** Optional ordering */
  orderBy?: { variable: string; direction: "asc" | "desc" }[];
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
        for (const order of query.orderBy!) {
          const aVal = a[order.variable];
          const bVal = b[order.variable];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return order.direction === "asc" ? -1 : 1;
          if (bVal == null) return order.direction === "asc" ? 1 : -1;

          // Handle symbol comparison
          if (typeof aVal === "symbol" || typeof bVal === "symbol") {
            const aStr = String(aVal);
            const bStr = String(bVal);
            if (aStr < bStr) return order.direction === "asc" ? -1 : 1;
            if (aStr > bStr) return order.direction === "asc" ? 1 : -1;
          } else {
            if (aVal < bVal) return order.direction === "asc" ? -1 : 1;
            if (aVal > bVal) return order.direction === "asc" ? 1 : -1;
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
    const entity = this.isVariable(clause.entity)
      ? undefined
      : (clause.entity as EntityId);
    const attribute = this.isVariable(clause.attribute)
      ? undefined
      : (clause.attribute as string);
    const value = this.isVariable(clause.value)
      ? undefined
      : (clause.value as Value);

    const datoms = await this.db.query({
      entity,
      attribute,
      value,
    });

    return datoms.map((datom) => ({
      entity: datom.entity,
      attribute: datom.attribute,
      value: datom.value,
    }));
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

    // Map clause positions to variable names
    const variableMap: Record<string, string> = {};
    for (const clause of clauses) {
      if (this.isVariable(clause.entity)) {
        variableMap["entity"] = clause.entity as string;
      }
      if (this.isVariable(clause.attribute)) {
        variableMap["attribute"] = clause.attribute as string;
      }
      if (this.isVariable(clause.value)) {
        variableMap["value"] = clause.value as string;
      }
    }

    return results.map((row) => {
      const projected: Record<string, Value> = {};
      for (const varName of find) {
        // Map variable name to actual column
        if (varName === variableMap.entity) {
          projected[varName] = row.entity;
        } else if (varName === variableMap.attribute) {
          projected[varName] = row.attribute;
        } else if (varName === variableMap.value) {
          projected[varName] = row.value;
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
