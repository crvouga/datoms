/**
 * Average aggregation - SQLite implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerAvgAggregation(): void {
  registerSQLAggregation(
    "avg",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        isValueColumn,
        dbType
      ) => {
        const sql = isValueColumn
          ? `AVG(${getValueExtraction(variableColumn, isValueColumn, dbType)}) AS ${escapeColumnName(outputKey, dbType)}`
          : `AVG(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`;
        return {
          sql,
          requiresGroupBy: false,
        };
      },
    },
    "sqlite"
  );
}
