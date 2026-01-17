/**
 * Aggregation computation functions
 */

import type { QueryResult } from "../../../datalog/datalog.js";
import type { Attribute, Value } from "../../../types.js";
import { getAggregationDefinition } from "./registry.js";
import { parseAggregation } from "./parser.js";

/**
 * Check if a query has any aggregations in the find clause
 * @param find Find clause object
 * @returns True if any aggregation is present
 */
export function hasAggregations(find: { [key: string]: unknown }): boolean {
  return Object.values(find).some((expr) => parseAggregation(expr) !== null);
}

/**
 * Compute aggregations on query results
 * @param results Query results before aggregation
 * @param find Find clause with aggregation expressions
 * @returns Aggregated results (typically a single row)
 */
export function applyAggregations(
  results: Record<string, Value | Attribute>[],
  find: { [key: string]: unknown }
): QueryResult {
  const aggregated: Record<string, Value | Attribute> = {};

  for (const [outputKey, expr] of Object.entries(find)) {
    const agg = parseAggregation(expr);
    if (agg) {
      // Variable names in results have the "?" prefix, so use the full variable name
      const varName = agg.variable;
      const values = results
        .map((row) => row[varName])
        .filter((v) => v !== undefined && v !== null);

      const def = getAggregationDefinition(agg.type);
      if (def) {
        aggregated[outputKey] = def.compute(values, agg.defaultValue);
      } else {
        // Fallback for unregistered aggregations
        aggregated[outputKey] = null;
      }
    } else {
      // Not an aggregation, handle in regular projection
      // This will be handled by the project function
    }
  }

  return [aggregated];
}
