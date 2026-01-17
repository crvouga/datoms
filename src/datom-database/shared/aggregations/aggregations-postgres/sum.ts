/**
 * Sum aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerSumAggregation(): void {
  registerSQLAggregation(
    "sum",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        isValueColumn,
        dbType
      ) => {
        const sql = isValueColumn
          ? `SUM(${getValueExtraction(variableColumn, isValueColumn, dbType)}) AS ${escapeColumnName(outputKey, dbType)}`
          : `SUM(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`;
        return {
          sql,
          requiresGroupBy: false,
        };
      },
    },
    "postgresql"
  );
}
