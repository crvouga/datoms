/**
 * Aggregation functions - main entry point
 */

// Import implementations to register all aggregations
import "./implementations.js";

export type { AggregationFunction, AggregationDefinition } from "./types.js";
export { getAggregationDefinition, registerAggregation } from "./registry.js";
export { parseAggregation } from "./parser.js";
export { hasAggregations, applyAggregations } from "./computation.js";
