/**
 * Sum aggregation - SQLite implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerSumAggregation(): void {
  registerSQLAggregation("sum", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      const sql = isValueColumn
        ? `SUM(${getValueExtraction(variableColumn, isValueColumn, "sqlite")}) AS ${escapeColumnName(outputKey, "sqlite")}`
        : `SUM(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "sqlite")}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    },
  });
}
