/**
 * Sum aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import { escapeColumnName, getValueExtraction } from "../shared/helpers.js";

SQLITE_AGGREGATIONS.set("sum", {
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
