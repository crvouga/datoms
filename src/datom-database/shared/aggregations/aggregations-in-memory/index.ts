/**
 * In-memory aggregations - register all implementations
 */

import { registerCountAggregation } from "./count.js";
import { registerCountDistinctAggregation } from "./count-distinct.js";
import { registerSumAggregation } from "./sum.js";
import { registerAvgAggregation } from "./avg.js";
import { registerMinAggregation } from "./min.js";
import { registerMaxAggregation } from "./max.js";
import { registerDistinctAggregation } from "./distinct.js";
import { registerRandAggregation } from "./rand.js";
import { registerSampleAggregation } from "./sample.js";
import { registerMedianAggregation } from "./median.js";
import { registerVarianceAggregation } from "./variance.js";
import { registerStddevAggregation } from "./stddev.js";

/**
 * Register all in-memory aggregation implementations
 */
export function registerAllInMemoryAggregations(): void {
  registerCountAggregation();
  registerCountDistinctAggregation();
  registerSumAggregation();
  registerAvgAggregation();
  registerMinAggregation();
  registerMaxAggregation();
  registerDistinctAggregation();
  registerRandAggregation();
  registerSampleAggregation();
  registerMedianAggregation();
  registerVarianceAggregation();
  registerStddevAggregation();
}

// Initialize all aggregations on module load
registerAllInMemoryAggregations();
