/**
 * Min aggregation - PostgreSQL implementation
 */

import { registerSQLAggregation } from "../shared/sql-registry.js";
import {
  escapeColumnName,
  escapeValue,
  getValueExtraction,
} from "../shared/helpers.js";

export function registerMinAggregation(): void {
  registerSQLAggregation(
    "min",
    {
      convert: (
        variableColumn,
        outputKey,
        defaultValue,
        isValueColumn,
        dbType
      ) => {
        // For min/max on value columns, extract as numeric for proper numeric comparison
        // This ensures 50 < 100 instead of "100" < "50" lexicographically
        const minColumn = isValueColumn
          ? getValueExtraction(variableColumn, isValueColumn, dbType)
          : variableColumn;
        const minDefault =
          defaultValue !== undefined
            ? `COALESCE(MIN(${minColumn}), ${escapeValue(defaultValue, dbType)})`
            : `MIN(${minColumn})`;
        return {
          sql: `${minDefault} AS ${escapeColumnName(outputKey, dbType)}`,
          requiresGroupBy: false,
        };
      },
    },
    "postgresql"
  );
}
