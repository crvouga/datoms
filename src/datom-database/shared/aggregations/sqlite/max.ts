/**
 * Max aggregation - SQLite implementation
 */

import { SQLITE_AGGREGATIONS } from "./registry.js";
import {
  escapeColumnName,
  escapeValue,
  getValueExtraction,
} from "../shared/helpers.js";

SQLITE_AGGREGATIONS.set("max", {
  convert: (variableColumn, outputKey, defaultValue, isValueColumn) => {
    // For min/max on value columns, extract as numeric for proper numeric comparison
    const maxColumn = isValueColumn
      ? getValueExtraction(variableColumn, isValueColumn, "sqlite")
      : variableColumn;
    const maxDefault =
      defaultValue !== undefined
        ? `COALESCE(MAX(${maxColumn}), ${escapeValue(defaultValue, "sqlite")})`
        : `MAX(${maxColumn})`;
    return {
      sql: `${maxDefault} AS ${escapeColumnName(outputKey, "sqlite")}`,
      requiresGroupBy: false,
    };
  },
});
