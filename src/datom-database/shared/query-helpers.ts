/**
 * Shared query processing functions for Datalog queries
 * These utilities are used across all database implementations
 *
 * @deprecated This file is kept for backward compatibility.
 * Please import directly from the new modules:
 * - Aggregations: `./aggregations/index.js`
 * - Query results: `./query-results.js`
 */

// Re-export aggregation functions
export {
  parseAggregation,
  hasAggregations,
  applyAggregations,
  type AggregationFunction,
  type AggregationDefinition,
} from "./aggregations/index.js";

// Re-export query result functions
export { joinResults, project } from "./query-results.js";
