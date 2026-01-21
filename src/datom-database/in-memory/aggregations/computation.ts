/**
 * Aggregation computation functions
 */

import type {Attribute, Value} from '../../../datoms.js';
import {IN_MEMORY_AGGREGATIONS} from './registry.js';
import {parseAggregation} from './parser.js';
import type {QueryResult} from '../../views/database-view.js';

/**
 * Check if a query has any aggregations in the find clause
 * @param find Find clause object
 * @returns True if any aggregation is present
 */
export function hasAggregations(find: {[key: string]: unknown}): boolean {
  return Object.values(find).some(expr => parseAggregation(expr) !== null);
}

/**
 * Compute aggregations on query results
 * @param results Query results before aggregation
 * @param find Find clause with aggregation expressions
 * @returns Aggregated results (typically a single row)
 */
export function applyAggregations(
  results: Record<string, Value | Attribute>[],
  find: {[key: string]: unknown},
): QueryResult {
  const aggregated: Record<string, Value | Attribute> = {};

  for (const [outputKey, expr] of Object.entries(find)) {
    const agg = parseAggregation(expr);
    if (agg) {
      // Variable names in results have the "?" prefix, so use the full variable name
      const varName = agg.variable;
      const values = results.map(row => row[varName]).filter(v => v !== undefined && v !== null);

      const def = IN_MEMORY_AGGREGATIONS.get(agg.type);
      if (def) {
        const result = def.compute(values, agg.defaultValue);
        // Use the result directly - the aggregation function handles count vs default logic
        aggregated[outputKey] = result;
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
