/**
 * Count aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import { escapeColumnName } from "./helpers.js";

SQLITE_AGGREGATIONS.set("count", {
  convert: (variableColumn, outputKey, _defaultValue, _isValueColumn) => ({
    sql: `COUNT(*) AS ${escapeColumnName(outputKey)}`,
    requiresGroupBy: false,
  }),
});
