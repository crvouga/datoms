/**
 * Distinct aggregation - PostgreSQL implementation
 */

import { POSTGRES_AGGREGATIONS } from "./registry.js";
import { escapeColumnName } from "./helpers.js";

POSTGRES_AGGREGATIONS.set("distinct", {
  convert: (variableColumn, outputKey, _defaultValue, _isValueColumn) => {
    // PostgreSQL supports ARRAY_AGG(DISTINCT ...)
    return {
      sql: `ARRAY_AGG(DISTINCT ${variableColumn}) AS ${escapeColumnName(outputKey)}`,
      requiresGroupBy: false,
    };
  },
});
