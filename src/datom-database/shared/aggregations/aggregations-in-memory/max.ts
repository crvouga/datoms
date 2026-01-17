/**
 * Max aggregation - in-memory implementation
 */

import type { Attribute, Value } from "../../../../datoms.js";
import { registerAggregation } from "./registry.js";

export function registerMaxAggregation(): void {
  registerAggregation("max", {
    compute: (values, defaultValue) => {
      if (values.length === 0) {
        return defaultValue !== undefined ? defaultValue : null;
      }
      const filtered = values.filter(
        (v): v is Value | Attribute => v !== null && v !== undefined
      );
      if (filtered.length === 0) {
        return defaultValue !== undefined ? defaultValue : null;
      }
      return filtered.reduce((a, b) => {
        if (a === null || a === undefined || b === null || b === undefined) {
          return a ?? b ?? null;
        }
        return (a > b ? a : b) as Value;
      }) as Value;
    },
    supportsDefault: true,
    requiresSeed: false,
  });
}
