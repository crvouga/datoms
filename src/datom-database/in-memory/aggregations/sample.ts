/**
 * Sample aggregation - in-memory implementation
 * Returns N random values without replacement (no duplicates)
 */

import type {Value} from '../../../datoms.js';
import {IN_MEMORY_AGGREGATIONS} from './registry.js';

IN_MEMORY_AGGREGATIONS.set('sample', {
  compute: (values, countStr) => {
    if (values.length === 0) {
      return null;
    }
    const count = countStr ? Number.parseInt(countStr, 10) : 1;
    if (Number.isNaN(count) || count <= 0) {
      return null;
    }

    // If count >= values.length, return all values
    if (count >= values.length) {
      return (count === 1 ? values[0] : values) as Value;
    }

    // Sample N random values without replacement (Fisher-Yates shuffle)
    const shuffled = [...values];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sampled = shuffled.slice(0, count);

    // If count is 1, return single value; otherwise return array
    return (count === 1 ? sampled[0] : sampled) as Value;
  },
  supportsDefault: false,
  requiresSeed: true, // Uses requiresSeed flag to indicate it needs the count parameter
});
