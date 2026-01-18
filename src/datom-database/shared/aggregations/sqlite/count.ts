/**
 * Count aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import { escapeColumnName } from "../shared/helpers.js";

SQLITE_AGGREGATIONS.set("count", {
  convert: (variableColumn, outputKey, _defaultValue, _isValueColumn) => ({
    sql: `COUNT(*) AS ${escapeColumnName(outputKey, "sqlite")}`,
    requiresGroupBy: false,
  }),
});
