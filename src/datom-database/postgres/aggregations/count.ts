/**
 * Count aggregation - PostgreSQL implementation
 */

import { POSTGRES_AGGREGATIONS } from "./registry.js";
import { escapeColumnName } from "./helpers.js";

POSTGRES_AGGREGATIONS.set("count", {
  convert: (variableColumn, outputKey, _defaultValue, _isValueColumn) => ({
    sql: `COUNT(*) AS ${escapeColumnName(outputKey)}`,
    requiresGroupBy: false,
  }),
});
