/**
 * Sum aggregation - in-memory implementation
 */

import { registerAggregation } from "./registry.js";

export function registerSumAggregation(): void {
  registerAggregation("sum", {
    compute: (values) => {
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      return numericValues.reduce((a, b) => a + b, 0);
    },
    supportsDefault: false,
    requiresSeed: false,
  });
}
