/**
 * Median aggregation - in-memory implementation
 */

import {IN_MEMORY_AGGREGATIONS} from './registry.js';

IN_MEMORY_AGGREGATIONS.set('median', {
  compute: values => {
    const numericValues = values.filter(v => typeof v === 'number') as number[];
    if (numericValues.length === 0) {
      return null;
    }
    const sorted = [...numericValues].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      // Even number of values: average of two middle values
      return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    } else {
      // Odd number of values: middle value
      return sorted[mid];
    }
  },
  supportsDefault: false,
  requiresSeed: false,
});
