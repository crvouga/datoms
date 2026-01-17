/**
 * Standard deviation aggregation - in-memory implementation
 */

import { registerAggregation } from "../shared/registry.js";

export function registerStddevAggregation(): void {
  registerAggregation("stddev", {
    compute: (values) => {
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      if (numericValues.length === 0) {
        return null;
      }
      // Calculate mean
      const mean =
        numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      // Calculate variance
      const variance =
        numericValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
        numericValues.length;
      // Standard deviation is square root of variance
      return Math.sqrt(variance);
    },
    supportsDefault: false,
    requiresSeed: false,
  });
}
