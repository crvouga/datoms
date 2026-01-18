/**
 * Variance aggregation - PostgreSQL implementation
 */

import { POSTGRES_AGGREGATIONS } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

POSTGRES_AGGREGATIONS.set("variance", {
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
