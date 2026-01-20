/**
 * Count aggregation - in-memory implementation
 */

import {IN_MEMORY_AGGREGATIONS} from './registry.js';

IN_MEMORY_AGGREGATIONS.set('count', {
  compute: values => values.length,
  supportsDefault: false,
  requiresSeed: false,
});
