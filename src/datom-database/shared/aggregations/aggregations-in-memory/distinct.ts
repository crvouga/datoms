/**
 * Distinct aggregation - in-memory implementation
 */

import type { Value } from "../../../../datoms.js";
import { registerAggregation } from "./registry.js";

export function registerDistinctAggregation(): void {
  registerAggregation("distinct", {
    compute: (values) => {
      const distinct = Array.from(
        new Set(values.map((v) => JSON.stringify(v)))
      ).map((v) => JSON.parse(v) as Value);
      return distinct as unknown as Value;
    },
    supportsDefault: false,
    requiresSeed: false,
  });
}
