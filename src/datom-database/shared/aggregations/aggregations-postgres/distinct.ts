/**
 * Distinct aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName } from "../shared/helpers.js";

export function registerDistinctAggregation(): void {
  registerSQLAggregation("distinct", {
    convert: (variableColumn, outputKey, _defaultValue, _isValueColumn) => {
      // PostgreSQL supports ARRAY_AGG(DISTINCT ...)
      return {
        sql: `ARRAY_AGG(DISTINCT ${variableColumn}) AS ${escapeColumnName(outputKey, "postgresql")}`,
        requiresGroupBy: false,
      };
    },
  });
}
