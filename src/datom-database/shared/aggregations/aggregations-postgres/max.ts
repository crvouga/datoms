/**
 * Max aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "./registry.js";
import {
  escapeColumnName,
  escapeValue,
  getValueExtraction,
} from "../shared/helpers.js";

export function registerMaxAggregation(): void {
  registerSQLAggregation("max", {
    convert: (variableColumn, outputKey, defaultValue, isValueColumn) => {
      // For min/max on value columns, extract as numeric for proper numeric comparison
      const maxColumn = isValueColumn
        ? getValueExtraction(variableColumn, isValueColumn, "postgresql")
        : variableColumn;
      const maxDefault =
        defaultValue !== undefined
          ? `COALESCE(MAX(${maxColumn}), ${escapeValue(defaultValue, "postgresql")})`
          : `MAX(${maxColumn})`;
      return {
        sql: `${maxDefault} AS ${escapeColumnName(outputKey, "postgresql")}`,
        requiresGroupBy: false,
      };
    },
  });
}
