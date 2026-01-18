/**
 * Base class for database views that filter queries by transaction ID
 * Provides common functionality for AsOf, History, and Since views
 */

import type { DatalogQuery, QueryResult } from "../../datalog/datalog.js";
import type { Attribute, Datom, Value } from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import type { QueryOptions } from "../../types.js";
import { QuerySafetyError } from "../hook/hook.js";
import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
} from "../shared/datalog-helpers.js";
import { joinResults, project } from "../shared/query-results.js";
import type { DatabaseView } from "./database-view.js";
import { InternalDatabaseView } from "./internal-database-view.js";

/**
 * Base class for database views that filter queries by transaction ID
 * Provides common functionality for AsOf, History, and Since views
 */
export abstract class BaseDatabaseView implements DatabaseView {
  constructor(protected db: InternalDatabaseView) {}

  abstract datoms(options: QueryOptions): Promise<Datom[]>;

  async query(
    query: DatalogQuery,
    context?: Record<string, unknown>
  ): Promise<QueryResult> {
    // Views need to execute queries using their filtered datoms() method
    // We'll execute the query manually using the view's datoms() method
    // Note: Views don't support hooks yet - they use the base database's hooks
    // through the db reference, but the context is passed through
    return this.executeQueryWithView(query, context);
  }

  /**
   * Execute a datalog query using the view's filtered datoms() method
   * This ensures time-travel filters are applied correctly
   */
  private async executeQueryWithView(
    query: DatalogQuery,
    _context?: Record<string, unknown>
  ): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    // Execute first clause using view's datoms() method
    const firstClause = query.where[0];
    if (!isQueryPattern(firstClause)) {
      throw new Error("First clause must be a QueryPattern");
    }
    const { e: entityVal, a: attributeVal, v: valueVal } = firstClause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    const firstDatoms = await this.datoms({
      e: entity,
      a: attribute,
      v: value,
    });

    // Map datom fields to variable names from the clause
    const firstResults = firstDatoms.map((datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom.e;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.a;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.v;
      }
      return result;
    });

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      if (!isQueryPattern(clause)) {
        throw new Error("Only QueryPattern clauses are supported in joins");
      }
      const { e: entityVal, a: attributeVal, v: valueVal } = clause;
      const entity = isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const clauseDatoms = await this.datoms({
        e: entity,
        a: attribute,
        v: value,
      });

      const clauseResults = clauseDatoms.map((datom) => {
        const result: Record<string, Value | Attribute> = {};
        if (isVariable(entityVal)) {
          result[entityVal as string] = datom.e;
        }
        if (isVariable(attributeVal)) {
          result[attributeVal as string] = datom.a;
        }
        if (isVariable(valueVal)) {
          result[valueVal as string] = datom.v;
        }
        return result;
      });

      results = joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    // Project to find variables
    const projected = project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];
          if (aVal === undefined && bVal === undefined) return 0;
          if (aVal === undefined || aVal === null)
            return direction === "asc" ? 1 : -1;
          if (bVal === undefined || bVal === null)
            return direction === "asc" ? -1 : 1;
          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit if specified
    if (query.limit !== undefined) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  /**
   * Validate that query has at least one filter or limit to prevent accidental full scans
   */
  protected validateQueryOptions(options: QueryOptions): void {
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
      );
    }
  }
}
