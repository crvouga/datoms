/**
 * Variance aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerVarianceAggregation(): void {
  registerSQLAggregation(
    "variance",
    {
      convert: (
        variableColumn,
        outputKey,
        _defaultValue,
        isValueColumn,
        dbType
      ) => {
        const sql = isValueColumn
          ? `VAR_POP(${getValueExtraction(variableColumn, isValueColumn, dbType)}) AS ${escapeColumnName(outputKey, dbType)}`
          : `VAR_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, dbType)}`;
        return {
          sql,
          requiresGroupBy: false,
        };
      },
    },
    "postgresql"
  );
}
