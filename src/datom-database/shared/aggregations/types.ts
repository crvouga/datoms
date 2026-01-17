/**
 * Types and interfaces for aggregation functions
 */

import type { Attribute, Value } from "../../../types.js";

/**
 * Aggregation function that computes a value from an array of values
 */
export type AggregationFunction = (
  values: (Value | Attribute)[],
  defaultValue?: string
) => Value | Attribute | null;

/**
 * Aggregation definition
 */
export interface AggregationDefinition {
  /** Function to compute the aggregation */
  compute: AggregationFunction;
  /** Whether this aggregation supports a default value */
  supportsDefault: boolean;
  /** Whether this aggregation requires a seed/default value */
  requiresSeed: boolean;
}
