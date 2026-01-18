/**
 * Variance aggregation - PostgreSQL implementation
 */

import { POSTGRES_AGGREGATIONS } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "./helpers.js";

POSTGRES_AGGREGATIONS.set("variance", {
  convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
    const sql = isValueColumn
      ? `VAR_POP(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
      : `VAR_POP(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
    return {
      sql,
      requiresGroupBy: false,
    };
  },
});
