/**
 * SQLite aggregations - register all implementations
 */

import { registerCountAggregation } from "./count.js";
import { registerCountDistinctAggregation } from "./count-distinct.js";
import { registerSumAggregation } from "./sum.js";
import { registerAvgAggregation } from "./avg.js";
import { registerMinAggregation } from "./min.js";
import { registerMaxAggregation } from "./max.js";

/**
 * Register all SQLite aggregation implementations
 */
export function registerAllSQLiteAggregations(): void {
  registerCountAggregation();
  registerCountDistinctAggregation();
  registerSumAggregation();
  registerAvgAggregation();
  registerMinAggregation();
  registerMaxAggregation();
}

// Initialize all aggregations on module load
registerAllSQLiteAggregations();
