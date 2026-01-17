/**
 * Average aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerAvgAggregation(): void {
  registerSQLAggregation("avg", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      const sql = isValueColumn
        ? `AVG(${getValueExtraction(variableColumn, isValueColumn, "postgresql")}) AS ${escapeColumnName(outputKey, "postgresql")}`
        : `AVG(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "postgresql")}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    },
  });
}
