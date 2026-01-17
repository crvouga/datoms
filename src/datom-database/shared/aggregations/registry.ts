/**
 * Registry for aggregation functions
 */

import type { AggregationDefinition } from "./types.js";

/**
 * Registry of all aggregation functions
 */
const AGGREGATION_REGISTRY: Map<string, AggregationDefinition> = new Map();

/**
 * Register an aggregation function
 */
export function registerAggregation(
  name: string,
  definition: AggregationDefinition
): void {
  AGGREGATION_REGISTRY.set(name, definition);
}

/**
 * Get aggregation definition
 */
export function getAggregationDefinition(
  name: string
): AggregationDefinition | undefined {
  return AGGREGATION_REGISTRY.get(name);
}
