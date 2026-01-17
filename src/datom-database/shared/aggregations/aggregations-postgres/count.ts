/**
 * Count aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import { escapeColumnName } from "../shared/helpers.js";

export function registerCountAggregation(): void {
  registerSQLAggregation(
    "count",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        _isValueColumn,
        dbType
      ) => ({
        sql: `COUNT(*) AS ${escapeColumnName(outputKey, dbType)}`,
        requiresGroupBy: false,
      }),
    },
    "postgresql"
  );
}
