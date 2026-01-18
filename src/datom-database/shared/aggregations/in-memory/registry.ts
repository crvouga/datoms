/**
 * Registry for in-memory aggregation functions
 */

import type { AggregationDefinition } from "./types.js";

/**
 * Registry of all in-memory aggregation functions
 */
export const IN_MEMORY_AGGREGATIONS: Map<string, AggregationDefinition> =
  new Map();
