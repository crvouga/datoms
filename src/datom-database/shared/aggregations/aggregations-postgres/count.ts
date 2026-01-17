/**
 * Count aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName } from "../shared/helpers.js";

export function registerCountAggregation(): void {
  registerSQLAggregation("count", {
    convert: (variableColumn, outputKey, _defaultValue, _isValueColumn) => ({
      sql: `COUNT(*) AS ${escapeColumnName(outputKey, "postgresql")}`,
      requiresGroupBy: false,
    }),
  });
}
