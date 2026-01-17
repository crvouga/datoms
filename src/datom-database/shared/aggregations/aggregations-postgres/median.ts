/**
 * Median aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerMedianAggregation(): void {
  registerSQLAggregation(
    "median",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        isValueColumn,
        dbType
      ) => {
        const sql = isValueColumn
          ? `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${getValueExtraction(variableColumn, isValueColumn, dbType)}) AS ${escapeColumnName(outputKey, dbType)}`
          : `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`;
        return {
          sql,
          requiresGroupBy: false,
        };
      },
    },
    "postgresql"
  );
}
