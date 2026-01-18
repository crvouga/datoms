/**
 * Count distinct aggregation - in-memory implementation
 */

import { IN_MEMORY_AGGREGATIONS } from "./registry.js";

IN_MEMORY_AGGREGATIONS.set("count-distinct", {
  compute: (values) => {
    const distinct = new Set(values.map((v) => JSON.stringify(v)));
    return distinct.size;
  },
  supportsDefault: false,
  requiresSeed: false,
});
