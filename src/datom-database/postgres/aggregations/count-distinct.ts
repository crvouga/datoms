/**
 * Count distinct aggregation - PostgreSQL implementation
 */

import {POSTGRES_AGGREGATIONS} from './registry.js';
import {escapeColumnName, getPostgresJSONBTextExtraction} from './helpers.js';

POSTGRES_AGGREGATIONS.set('count-distinct', {
  convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
    // For JSONB columns, we need to extract the value first as text
    const distinctColumn = isValueColumn
      ? getPostgresJSONBTextExtraction(variableColumn, isValueColumn)
      : variableColumn;
    return {
      sql: `COUNT(DISTINCT ${distinctColumn}) AS ${escapeColumnName(outputKey)}`,
      requiresGroupBy: false,
    };
  },
});
