/**
 * Average aggregation - SQLite implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerAvgAggregation(): void {
  registerSQLAggregation("avg", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      const sql = isValueColumn
        ? `AVG(${getValueExtraction(variableColumn, isValueColumn, "sqlite")}) AS ${escapeColumnName(outputKey, "sqlite")}`
        : `AVG(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "sqlite")}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    },
  });
}
