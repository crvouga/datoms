/**
 * Count distinct aggregation - SQLite implementation
 */

import { registerSQLAggregation } from "./registry.js";
import {
  escapeColumnName,
  getSQLiteJSONTextExtraction,
} from "../shared/helpers.js";

export function registerCountDistinctAggregation(): void {
  registerSQLAggregation("count-distinct", {
    convert: (variableColumn, outputKey, _defaultValue, isValueColumn) => {
      // For JSON columns, we need to extract the value first as text
      const distinctColumn = isValueColumn
        ? getSQLiteJSONTextExtraction(variableColumn, isValueColumn)
        : variableColumn;
      return {
        sql: `COUNT(DISTINCT ${distinctColumn}) AS ${escapeColumnName(outputKey, "sqlite")}`,
        requiresGroupBy: false,
      };
    },
  });
}
