/**
 * Median aggregation - PostgreSQL implementation
 */

import { POSTGRES_AGGREGATIONS } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

POSTGRES_AGGREGATIONS.set("median", {
  convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
    const sql = isValueColumn
      ? `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${getValueExtraction(variableColumn, isValueColumn, "postgresql")}) AS ${escapeColumnName(outputKey, "postgresql")}`
      : `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey, "postgresql")}`;
    return {
      sql,
      requiresGroupBy: false,
    };
  },
});
