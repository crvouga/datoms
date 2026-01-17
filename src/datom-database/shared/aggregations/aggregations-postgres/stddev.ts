/**
 * Standard deviation aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerStddevAggregation(): void {
  registerSQLAggregation("stddev", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      const sql = isValueColumn
        ? `STDDEV_POP(${getValueExtraction(variableColumn, isValueColumn, "postgresql")}) AS ${escapeColumnName(outputKey, "postgresql")}`
        : `STDDEV_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "postgresql")}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    },
  });
}
