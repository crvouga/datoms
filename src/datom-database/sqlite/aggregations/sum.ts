/**
 * Sum aggregation - SQLite implementation
 */

import {SQLITE_AGGREGATIONS} from './registry.js';
import {escapeColumnName, getValueExtraction} from './helpers.js';

SQLITE_AGGREGATIONS.set('sum', {
  convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
    const sql = isValueColumn
      ? `SUM(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
      : `SUM(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
    return {
      sql,
      requiresGroupBy: false,
    };
  },
});
