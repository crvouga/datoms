/**
 * Aggregation functions - main entry point
 */

// Import implementations to register all aggregations
import "./in-memory/index.js";
import "./postgres/index.js";
import "./sqlite/index.js";

export { applyAggregations, hasAggregations } from "./in-memory/computation.js";
export { parseAggregation } from "./in-memory/parser.js";
export { IN_MEMORY_AGGREGATIONS } from "./in-memory/registry.js";
export type {
  AggregationDefinition,
  AggregationFunction,
} from "./in-memory/types.js";
export { POSTGRES_AGGREGATIONS } from "./postgres/registry.js";
export { aggregationToSQL, checkSQLAggregations } from "./shared/helpers.js";
export { SQLITE_AGGREGATIONS } from "./sqlite/registry.js";
