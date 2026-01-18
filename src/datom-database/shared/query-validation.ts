/**
 * Shared query validation utilities
 */

import type { QueryOptions } from "../../types.js";
import { QuerySafetyError } from "../hook/hook.js";

/**
 * Validate that query has at least one filter or limit to prevent accidental full scans
 */
export function validateQueryOptions(options: QueryOptions): void {
  const hasFilter =
    options.e !== undefined ||
    options.a !== undefined ||
    options.v !== undefined ||
    options.tx !== undefined;
  const hasLimit = options.limit !== undefined;

  if (!hasFilter && !hasLimit) {
    throw new QuerySafetyError(
      "Query must include at least one filter (entity, attribute, value, tx) or a limit to prevent full table scans"
    );
  }
}
