/**
 * Standard deviation aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerStddevAggregation(): void {
  registerSQLAggregation(
    "stddev",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        isValueColumn,
        dbType
      ) => {
        const sql = isValueColumn
          ? `STDDEV_POP(${getValueExtraction(variableColumn, isValueColumn, dbType)}) AS ${escapeColumnName(outputKey, dbType)}`
          : `STDDEV_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`;
        return {
          sql,
          requiresGroupBy: false,
        };
      },
    },
    "postgresql"
  );
}
