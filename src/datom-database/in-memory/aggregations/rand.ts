/**
 * Random aggregation - in-memory implementation
 * Returns N random values with replacement (can return duplicates)
 */

import type {Attribute, Value} from '../../../datoms.js';
import {IN_MEMORY_AGGREGATIONS} from './registry.js';

IN_MEMORY_AGGREGATIONS.set('rand', {
  compute: (values, countStr) => {
    if (values.length === 0) {
      return null;
    }
    const count = countStr ? Number.parseInt(countStr, 10) : 1;
    if (Number.isNaN(count) || count <= 0) {
      return null;
    }

    // Generate N random values with replacement
    const result: (Value | Attribute)[] = [];
    for (let i = 0; i < count; i++) {
      const randomIndex = Math.floor(Math.random() * values.length);
      result.push(values[randomIndex]);
    }

    // If count is 1, return single value; otherwise return array
    return (count === 1 ? result[0] : result) as Value;
  },
  supportsDefault: false,
  requiresSeed: true, // Uses requiresSeed flag to indicate it needs the count parameter
});
