/**
 * Shared query processing functions for Datalog queries
 * These utilities are used across all database implementations
 */

import type { QueryClause, QueryResult } from "../../datalog/datalog.js";
import type { Attribute, Value } from "../../types.js";
import { stripQuestionMark } from "./datalog-helpers.js";

/**
 * Join two result sets based on common variables
 * Rows are compatible if they have the same values for common variables
 * @param left Left result set
 * @param right Right result set
 * @param _clauses Query clauses (unused, kept for compatibility)
 * @returns Joined result set
 */
export function joinResults(
  left: Record<string, Value | Attribute>[],
  right: Record<string, Value | Attribute>[],
  _clauses: QueryClause[]
): Record<string, Value | Attribute>[] {
  const joined: Record<string, Value | Attribute>[] = [];

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
 * Strips the question mark prefix from variable names in the result keys
 * @param results Query results with variable names as keys
 * @param find Array of variable names to include in the projection
 * @param _clauses Query clauses (unused, kept for compatibility)
 * @returns Projected results with question mark prefix stripped from keys
 */
export function project(
  results: Record<string, Value | Attribute>[],
  find: string[],
  _clauses: QueryClause[]
): QueryResult {
  if (find.length === 0) {
    // Strip ? from all keys when find is empty
    return results.map((row) => {
      const projected: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        projected[stripQuestionMark(key)] = row[key];
      }
      return projected;
    });
  }

  // Results already have variable names as keys, so just extract the find variables
  // Strip ? from keys in the projected result
  return results.map((row) => {
    const projected: Record<string, Value | Attribute> = {};
    for (const varName of find) {
      if (varName in row) {
        projected[stripQuestionMark(varName)] = row[varName];
      }
    }
    return projected;
  });
}
