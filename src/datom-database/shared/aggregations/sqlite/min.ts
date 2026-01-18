/**
 * Min aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import {
  escapeColumnName,
  escapeValue,
  getValueExtraction,
} from "../shared/helpers.js";

SQLITE_AGGREGATIONS.set("min", {
  convert: (variableColumn, outputKey, defaultValue, isValueColumn) => {
    // For min/max on value columns, extract as numeric for proper numeric comparison
    const minColumn = isValueColumn
      ? getValueExtraction(variableColumn, isValueColumn, "sqlite")
      : variableColumn;
    const minDefault =
      defaultValue !== undefined
        ? `COALESCE(MIN(${minColumn}), ${escapeValue(defaultValue, "sqlite")})`
        : `MIN(${minColumn})`;
    return {
      sql: `${minDefault} AS ${escapeColumnName(outputKey, "sqlite")}`,
      requiresGroupBy: false,
    };
  },
});
