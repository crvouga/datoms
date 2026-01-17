/**
 * Aggregation functions - main entry point
 */

// Import implementations to register all aggregations
import "./aggregations-in-memory/index.js";
import "./aggregations-postgres/index.js";
import "./aggregations-sqlite/index.js";

export type {
  AggregationFunction,
  AggregationDefinition,
} from "./aggregations-in-memory/types.js";
export {
  getAggregationDefinition,
  registerAggregation,
} from "./aggregations-in-memory/registry.js";
export { parseAggregation } from "./shared/parser.js";
export { hasAggregations, applyAggregations } from "./shared/computation.js";
export { aggregationToSQL, checkSQLAggregations } from "./sql-helpers.js";
export type { DatabaseType, SQLAggregationResult } from "./sql-helpers.js";
