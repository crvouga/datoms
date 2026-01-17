/**
 * Count distinct aggregation - in-memory implementation
 */

import { registerAggregation } from "./registry.js";

export function registerCountDistinctAggregation(): void {
  registerAggregation("count-distinct", {
    compute: (values) => {
      const distinct = new Set(values.map((v) => JSON.stringify(v)));
      return distinct.size;
    },
    supportsDefault: false,
    requiresSeed: false,
  });
}
