/**
 * Average aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

SQLITE_AGGREGATIONS.set("avg", {
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
