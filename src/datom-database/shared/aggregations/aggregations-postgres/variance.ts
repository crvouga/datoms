/**
 * Variance aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

export function registerVarianceAggregation(): void {
  registerSQLAggregation("variance", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      const sql = isValueColumn
        ? `VAR_POP(${getValueExtraction(variableColumn, isValueColumn, "postgresql")}) AS ${escapeColumnName(outputKey, "postgresql")}`
        : `VAR_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "postgresql")}`;
      return {
        sql,
        requiresGroupBy: false,
      };
    },
  });
}
