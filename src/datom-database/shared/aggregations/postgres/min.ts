/**
 * Min aggregation - PostgreSQL implementation
 */

import { POSTGRES_AGGREGATIONS } from "./registry.js";
import {
  escapeColumnName,
  escapeValue,
  getValueExtraction,
} from "../shared/helpers.js";

POSTGRES_AGGREGATIONS.set("min", {
  convert: (variableColumn, outputKey, defaultValue, isValueColumn) => {
    // For min/max on value columns, extract as numeric for proper numeric comparison
    // This ensures 50 < 100 instead of "100" < "50" lexicographically
    const minColumn = isValueColumn
      ? getValueExtraction(variableColumn, isValueColumn, "postgresql")
      : variableColumn;
    const minDefault =
      defaultValue !== undefined
        ? `COALESCE(MIN(${minColumn}), ${escapeValue(defaultValue, "postgresql")})`
        : `MIN(${minColumn})`;
    return {
      sql: `${minDefault} AS ${escapeColumnName(outputKey, "postgresql")}`,
      requiresGroupBy: false,
    };
  },
});
