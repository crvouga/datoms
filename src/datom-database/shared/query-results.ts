/**
 * Query result operations - joining and projecting results
 */

import type {QueryClause} from '../../datalog/datalog.js';
import type {Attribute, Value} from '../../datoms.js';
// Import aggregations to ensure they're registered
import '../in-memory/aggregations/index.js';
import {applyAggregations, hasAggregations} from '../in-memory/aggregations/computation.js';
import {parseAggregation} from '../in-memory/aggregations/parser.js';
import {stripQuestionMark} from './datalog-helpers.js';
import type {QueryResult} from '../views/database-view.js';

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
  _clauses: QueryClause[],
): Record<string, Value | Attribute>[] {
  const joined: Record<string, Value | Attribute>[] = [];

  // Find all shared variables (excluding metadata)
  const leftKeys = new Set(Object.keys(left[0] || {}));
  const rightKeys = new Set(Object.keys(right[0] || {}));
  const sharedNonMetadataVars = new Set<string>();
  for (const key of leftKeys) {
    if (key !== '?e' && key !== '?a' && key !== '?v' && key !== '?tx' && rightKeys.has(key)) {
      sharedNonMetadataVars.add(key);
    }
  }

  // If there are shared non-metadata variables, exclude ?e from compatibility check
  // Otherwise, include ?e in the compatibility check (for cases where ?e is the join key)

  for (const leftRow of left) {
    for (const rightRow of right) {
      // Check if rows are compatible (same values for common variables)
      let compatible = true;

      // First, check shared non-metadata variables if they exist
      // If these match, the join is compatible (we allow ?e to differ in this case)
      if (sharedNonMetadataVars.size > 0) {
        for (const key of sharedNonMetadataVars) {
          if (key in leftRow && key in rightRow && leftRow[key] !== rightRow[key]) {
            compatible = false;
            break;
          }
        }
        if (!compatible) continue;
      } else {
        // No shared non-metadata variables - require ?e to match for compatibility
        // ?e is always present in both rows, so we need to check if values match
        const leftE = leftRow['?e'];
        const rightE = rightRow['?e'];
        if (leftE === undefined || rightE === undefined || leftE !== rightE) {
          continue; // Skip this row pair - ?e doesn't match or is not present
        }
        // If we reach here, ?e matches, so rows are compatible
        compatible = true;
      }

      // Always skip ?a, ?v, and ?tx - they represent different attributes, values,
      // or transaction metadata in different clauses and should not prevent joining

      if (compatible) {
        joined.push({...leftRow, ...rightRow});
      }
    }
  }

  return joined;
}

/**
 * Project results to only include find variables
 * Strips the question mark prefix from variable names in the result keys
 * Handles aggregations by computing them before projection
 * @param results Query results with variable names as keys
 * @param find Object mapping output keys to variable names (e.g., { x: "?x", name: "?name" })
 * @param _clauses Query clauses (unused, kept for compatibility)
 * @returns Projected results with question mark prefix stripped from keys
 */
export function project(
  results: Record<string, Value | Attribute>[],
  find: {[key: string]: unknown},
  _clauses: QueryClause[],
): QueryResult {
  const findKeys = Object.keys(find);

  // Check if results are already aggregated (they have output keys instead of variable names)
  // This happens when applyAggregations was called before project
  const isAlreadyAggregated =
    results.length > 0 &&
    findKeys.some(outputKey => {
      const expr = find[outputKey];
      const agg = parseAggregation(expr);
      return agg && results[0] && outputKey in results[0];
    });

  // Helper function to project a single row
  const projectRow = (row: Record<string, Value | Attribute>) => {
    const projected: Record<string, Value | Attribute> = {};
    for (const outputKey of findKeys) {
      const expr = find[outputKey];
      const agg = parseAggregation(expr);
      if (agg) {
        // This is an aggregation, already computed
        if (outputKey in row) {
          projected[outputKey] = row[outputKey];
        }
      } else {
        // Regular variable projection - extract variable from tuple or string
        let varName: string;
        if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
          varName = expr[0];
        } else if (typeof expr === 'string') {
          varName = expr;
        } else {
          continue;
        }
        if (varName in row) {
          projected[outputKey] = row[varName];
        }
      }
    }
    return projected;
  };

  // Handle empty find clause - strip ? from all keys
  if (findKeys.length === 0) {
    return results.map(row => {
      const projected: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        projected[stripQuestionMark(key)] = row[key];
      }
      return projected;
    });
  }

  // Check if we have aggregations
  if (hasAggregations(find) && !isAlreadyAggregated) {
    // Apply aggregations first
    const aggregated = applyAggregations(results, find);
    // Then project the aggregated results
    return aggregated.map(projectRow);
  }

  // If already aggregated or no aggregations, just project the results
  return results.map(projectRow);
}
