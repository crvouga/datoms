/**
 * Aggregation functions - main entry point
 */

// Import implementations to register all aggregations
import "./in-memory/index.js";
import "./postgres/index.js";
import "./sqlite/index.js";

export { IN_MEMORY_AGGREGATIONS } from "./in-memory/registry.js";
export type {
  AggregationDefinition,
  AggregationFunction,
} from "./in-memory/types.js";
export { POSTGRES_AGGREGATIONS } from "./postgres/registry.js";
export { SQLITE_AGGREGATIONS } from "./sqlite/registry.js";
export { applyAggregations, hasAggregations } from "./shared/computation.js";
export { parseAggregation } from "./shared/parser.js";
export { aggregationToSQL, checkSQLAggregations } from "./sql-helpers.js";
export type { DatabaseType, SQLAggregationResult } from "./sql-helpers.js";
