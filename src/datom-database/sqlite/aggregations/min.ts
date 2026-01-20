/**
 * Min aggregation - SQLite implementation
 */

import {SQLITE_AGGREGATIONS} from './registry.js';
import {escapeColumnName, escapeValue, getValueExtraction} from './helpers.js';

SQLITE_AGGREGATIONS.set('min', {
  convert: (variableColumn, outputKey, defaultValue, isValueColumn) => {
    // For min/max on value columns, extract as numeric for proper numeric comparison
    const minColumn = isValueColumn
      ? getValueExtraction(variableColumn, isValueColumn)
      : variableColumn;
    const minDefault =
      defaultValue !== undefined
        ? `COALESCE(MIN(${minColumn}), ${escapeValue(defaultValue)})`
        : `MIN(${minColumn})`;
    return {
      sql: `${minDefault} AS ${escapeColumnName(outputKey)}`,
      requiresGroupBy: false,
    };
  },
});
