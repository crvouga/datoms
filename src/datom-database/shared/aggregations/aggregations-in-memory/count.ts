/**
 * Count aggregation - in-memory implementation
 */

import { registerAggregation } from "../shared/registry.js";

export function registerCountAggregation(): void {
  registerAggregation("count", {
    compute: (values) => values.length,
    supportsDefault: false,
    requiresSeed: false,
  });
}
