/**
 * Average aggregation - in-memory implementation
 */

import { IN_MEMORY_AGGREGATIONS } from "./registry.js";

IN_MEMORY_AGGREGATIONS.set("avg", {
  compute: (values) => {
    if (values.length === 0) {
      return null;
    }
    const numericValues = values.filter(
      (v) => typeof v === "number"
    ) as number[];
    if (numericValues.length === 0) {
      return null;
    }
    const sum = numericValues.reduce((a, b) => a + b, 0);
    return sum / numericValues.length;
  },
  supportsDefault: false,
  requiresSeed: false,
});
