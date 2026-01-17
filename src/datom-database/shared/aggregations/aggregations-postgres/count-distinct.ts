/**
 * Count distinct aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import {
  escapeColumnName,
  getPostgresJSONBTextExtraction,
} from "../shared/helpers.js";

export function registerCountDistinctAggregation(): void {
  registerSQLAggregation(
    "count-distinct",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        isValueColumn,
        dbType
      ) => {
        // For JSONB columns, we need to extract the value first as text
        const distinctColumn = isValueColumn
          ? getPostgresJSONBTextExtraction(variableColumn, isValueColumn)
          : variableColumn;
        return {
          sql: `COUNT(DISTINCT ${distinctColumn}) AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      },
    },
    "postgresql"
  );
}
