/**
 * Max aggregation - in-memory implementation
 * When a count is provided (3-arg form: ["max", count, "?var"]), returns top N max values
 * When a default is provided (3-arg form: ["max", default, "?var"]), returns max or default if no values
 * When no second arg (2-arg form: ["max", "?var"]), returns single max value
 */

import type {Attribute, Value} from '../../../datoms.js';
import {IN_MEMORY_AGGREGATIONS} from './registry.js';

IN_MEMORY_AGGREGATIONS.set('max', {
  compute: (values, countOrDefault) => {
    const filtered = values.filter((v): v is Value | Attribute => v !== null && v !== undefined);

    if (filtered.length === 0) {
      // No values - return default if provided, otherwise null
      return countOrDefault !== undefined ? countOrDefault : null;
    }

    // Sort values in descending order (largest first)
    const sorted = [...filtered].sort((a, b) => {
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      // Compare values - return negative if a > b (a should come first)
      if (a > b) return -1;
      if (a < b) return 1;
      return 0;
    });

    // The max value is always sorted[0] (the largest value)
    const maxValue = sorted[0] as Value;

    // If countOrDefault is provided, it's a count (top N), not a default
    // For max, the second arg is always a count when values exist
    if (countOrDefault !== undefined) {
      // Try to parse as number to see if it's a count
      const parsedCount =
        typeof countOrDefault === 'string' ? Number.parseInt(countOrDefault, 10) : countOrDefault;
      // If it's a valid positive number, treat it as count (top N)
      if (!Number.isNaN(parsedCount) && typeof parsedCount === 'number' && parsedCount > 0) {
        // For count=1, return the single max value
        if (parsedCount === 1) {
          return maxValue;
        }
        // For count > 1, return array of top N values
        const topN = sorted.slice(0, parsedCount);
        return topN as unknown as Value;
      }
    }

    // Return single max value (when no count specified or invalid count)
    return maxValue;
  },
  supportsDefault: true,
  requiresSeed: false, // Second argument is optional - can be count (top N) or default when no values
});
