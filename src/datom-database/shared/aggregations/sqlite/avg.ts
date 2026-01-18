/**
 * Average aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "./helpers.js";

SQLITE_AGGREGATIONS.set("avg", {
  convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
    const sql = isValueColumn
      ? `AVG(${getValueExtraction(variableColumn, isValueColumn)}) AS ${escapeColumnName(outputKey)}`
      : `AVG(CAST(${variableColumn} AS NUMERIC)) AS ${escapeColumnName(outputKey)}`;
    return {
      sql,
      requiresGroupBy: false,
    };
  },
});
