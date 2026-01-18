/**
 * Sum aggregation - in-memory implementation
 */

import { IN_MEMORY_AGGREGATIONS } from "./registry.js";

IN_MEMORY_AGGREGATIONS.set("sum", {
  compute: (values) => {
    const numericValues = values.filter(
      (v) => typeof v === "number"
    ) as number[];
    return numericValues.reduce((a, b) => a + b, 0);
  },
  supportsDefault: false,
  requiresSeed: false,
});
