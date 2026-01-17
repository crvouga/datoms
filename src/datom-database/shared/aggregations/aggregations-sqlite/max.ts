/**
 * Max aggregation - SQLite implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import {
  escapeColumnName,
  escapeValue,
  getValueExtraction,
} from "../shared/helpers.js";

export function registerMaxAggregation(): void {
  registerSQLAggregation(
    "max",
    {
      convert: (
        variableColumn,
        outputKey,
        defaultValue,
        isValueColumn,
        dbType
      ) => {
        // For min/max on value columns, extract as numeric for proper numeric comparison
        const maxColumn = isValueColumn
          ? getValueExtraction(variableColumn, isValueColumn, dbType)
          : variableColumn;
        const maxDefault =
          defaultValue !== undefined
            ? `COALESCE(MAX(${maxColumn}), ${escapeValue(defaultValue, dbType)})`
            : `MAX(${maxColumn})`;
        return {
          sql: `${maxDefault} AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      },
    },
    "sqlite"
  );
}
