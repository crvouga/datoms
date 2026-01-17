/**
 * Sum aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerSumAggregation(): void {
  registerSQLAggregation("sum", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      const sql = isValueColumn
        ? `SUM(${getValueExtraction(variableColumn, isValueColumn, "postgresql")}) AS ${escapeColumnName(outputKey, "postgresql")}`
        : `SUM(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "postgresql")}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    },
  });
}
