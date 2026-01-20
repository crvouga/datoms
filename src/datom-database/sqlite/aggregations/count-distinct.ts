/**
 * Count distinct aggregation - SQLite implementation
 */

import {SQLITE_AGGREGATIONS} from './registry.js';
import {escapeColumnName, getSQLiteJSONTextExtraction} from './helpers.js';

SQLITE_AGGREGATIONS.set('count-distinct', {
  convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
    // For JSON columns, we need to extract the value first as text
    const distinctColumn = isValueColumn
      ? getSQLiteJSONTextExtraction(variableColumn, isValueColumn)
      : variableColumn;
    return {
      sql: `COUNT(DISTINCT ${distinctColumn}) AS ${escapeColumnName(outputKey)}`,
      requiresGroupBy: false,
    };
  },
});
