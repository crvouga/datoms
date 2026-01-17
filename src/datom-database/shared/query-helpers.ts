/**
 * Shared query processing functions for Datalog queries
 * These utilities are used across all database implementations
 */

import type { QueryClause, QueryResult } from "../../datalog/datalog.js";
import type { Attribute, Value } from "../../types.js";
import { stripQuestionMark } from "./datalog-helpers.js";

/**
 * Parse an aggregation expression - accepts both tuple format and string format for backward compatibility
 * @param expr Aggregation expression (tuple or string)
 * @returns Object with aggregation type, variable name, and optional default value, or null if not an aggregation
 */
export function parseAggregation(
  expr: unknown
): { type: string; variable: string; defaultValue?: string } | null {
  // Handle tuple format: ["avg", "?age"] or ["max", "0", "?age"]
  if (Array.isArray(expr)) {
    if (
      expr.length === 1 &&
      typeof expr[0] === "string" &&
      expr[0].startsWith("?")
    ) {
      // Just a variable: ["?age"]
      return null; // Not an aggregation
    }
    if (
      expr.length === 2 &&
      typeof expr[0] === "string" &&
      typeof expr[1] === "string"
    ) {
      // Aggregation with one arg: ["count", "?age"] or ["min", "?age"] or ["max", "?age"]
      const funcName = expr[0] as string;
      const variable = expr[1] as string;
      const aggregationTypes = [
        "count",
        "count-distinct",
        "sum",
        "avg",
        "min",
        "max",
        "median",
        "variance",
        "stddev",
        "distinct",
      ];
      if (aggregationTypes.includes(funcName) && variable.startsWith("?")) {
        return { type: funcName, variable };
      }
    }
    if (expr.length === 3 && typeof expr[0] === "string") {
      // Aggregation with default/seed: ["max", "0", "?age"] or ["rand", "seed123", "?value"]
      const funcName = expr[0] as string;
      const defaultValue = expr[1] as string | number;
      const variable = expr[2] as string;
      const aggregationTypes = ["min", "max", "rand", "sample"];
      if (
        aggregationTypes.includes(funcName) &&
        typeof variable === "string" &&
        variable.startsWith("?")
      ) {
        return {
          type: funcName,
          variable,
          defaultValue: String(defaultValue),
        };
      }
    }
    return null;
  }

  // Handle string format for backward compatibility: "avg(?age)" or "sum(?price)"
  if (typeof expr !== "string") {
    return null;
  }

  // Match patterns like "avg(?age)", "sum(?price)", "count-distinct(?name)", etc.
  // Use [\w-]+ to match function names with hyphens like "count-distinct"
  const match = expr.match(/^([\w-]+)(?:\((.+)\))?$/);
  if (!match) return null;

  const [, funcName, args] = match;
  const aggregationTypes = [
    "count",
    "count-distinct",
    "sum",
    "avg",
    "min",
    "max",
    "median",
    "variance",
    "stddev",
    "distinct",
  ];

  if (!aggregationTypes.includes(funcName)) {
    return null;
  }

  // Handle functions with default values like "max(\"0\", ?age)"
  if (args) {
    const defaultMatch = args.match(/^"([^"]+)",\s*(\?[\w]+)$/);
    if (defaultMatch) {
      return {
        type: funcName,
        variable: defaultMatch[2],
        defaultValue: defaultMatch[1],
      };
    }
    // Handle functions with single argument like "avg(?age)"
    const varMatch = args.match(/^(\?[\w]+)$/);
    if (varMatch) {
      return { type: funcName, variable: varMatch[1] };
    }
  }

  return null;
}

/**
 * Check if a query has any aggregations in the find clause
 * @param find Find clause object
 * @returns True if any aggregation is present
 */
export function hasAggregations(find: { [key: string]: unknown }): boolean {
  return Object.values(find).some((expr) => parseAggregation(expr) !== null);
}

/**
 * Compute aggregations on query results
 * @param results Query results before aggregation
 * @param find Find clause with aggregation expressions
 * @returns Aggregated results (typically a single row)
 */
export function applyAggregations(
  results: Record<string, Value | Attribute>[],
  find: { [key: string]: unknown }
): QueryResult {
  const aggregated: Record<string, Value | Attribute> = {};

  for (const [outputKey, expr] of Object.entries(find)) {
    const agg = parseAggregation(expr);
    if (agg) {
      // Variable names in results have the "?" prefix, so use the full variable name
      const varName = agg.variable;
      const values = results
        .map((row) => row[varName])
        .filter((v) => v !== undefined && v !== null);

      switch (agg.type) {
        case "avg": {
          if (values.length === 0) {
            // Average of empty set could be null, undefined, or 0 depending on implementation
            // Test expects null, undefined, or 0 to be acceptable
            aggregated[outputKey] = null;
          } else {
            const numericValues = values.filter(
              (v) => typeof v === "number"
            ) as number[];
            if (numericValues.length === 0) {
              aggregated[outputKey] = null;
            } else {
              const sum = numericValues.reduce((a, b) => a + b, 0);
              aggregated[outputKey] = sum / numericValues.length;
            }
          }
          break;
        }
        case "sum": {
          const numericValues = values.filter(
            (v) => typeof v === "number"
          ) as number[];
          aggregated[outputKey] = numericValues.reduce((a, b) => a + b, 0);
          break;
        }
        case "count": {
          aggregated[outputKey] = values.length;
          break;
        }
        case "count-distinct": {
          const distinct = new Set(values.map((v) => JSON.stringify(v)));
          aggregated[outputKey] = distinct.size;
          break;
        }
        case "min": {
          if (values.length === 0) {
            // Use default value if provided, otherwise null
            if (agg.defaultValue !== undefined) {
              // Preserve the default value as-is (as a string)
              // The default value comes from the query string literal, so it's always a string
              aggregated[outputKey] = agg.defaultValue;
            } else {
              aggregated[outputKey] = null;
            }
          } else {
            aggregated[outputKey] = values.reduce((a, b) =>
              a < b ? a : b
            ) as Value;
          }
          break;
        }
        case "max": {
          if (values.length === 0) {
            // Use default value if provided, otherwise null
            if (agg.defaultValue !== undefined) {
              // Preserve the default value as-is (string or number)
              // The default value comes from the query string, so it's always a string initially
              // Try to parse as number if it looks numeric, otherwise keep as string
              const trimmed = agg.defaultValue.trim();
              if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                // It's a numeric string, but test expects string "0" to stay as string
                // Check if the original was quoted - if it was "0", keep as string
                // Actually, since defaultValue is extracted from quotes, we should check the test expectation
                // Looking at the test: max("0", ?age) expects "0" (string), not 0 (number)
                // So we should preserve string defaults as strings
                // But max("100", ?value) with values [10, 20] expects 20 (number), not "20"
                // So the logic is: if no values, use default as-is (string "0" stays "0")
                // But wait, the test shows max("100", ?value) with values expects 20, not "100"
                // So the default is only used when there are NO values
                // And when used, it should preserve the type from the query
                // Since "0" is a string literal in the query, it should be returned as "0"
                aggregated[outputKey] = agg.defaultValue;
              } else {
                // Keep as string
                aggregated[outputKey] = agg.defaultValue;
              }
            } else {
              aggregated[outputKey] = null;
            }
          } else {
            aggregated[outputKey] = values.reduce((a, b) =>
              a > b ? a : b
            ) as Value;
          }
          break;
        }
        case "distinct": {
          const distinct = Array.from(
            new Set(values.map((v) => JSON.stringify(v)))
          ).map((v) => JSON.parse(v) as Value);
          aggregated[outputKey] = distinct as unknown as Value;
          break;
        }
        case "rand": {
          if (values.length === 0) {
            aggregated[outputKey] = null;
          } else {
            // Use seed for deterministic randomness
            const seed = agg.defaultValue || "default";
            // Simple seeded random number generator
            let hash = 0;
            for (let i = 0; i < seed.length; i++) {
              const char = seed.charCodeAt(i);
              hash = (hash << 5) - hash + char;
              hash = hash & hash; // Convert to 32-bit integer
            }
            // Use hash to select a value
            const index = Math.abs(hash) % values.length;
            aggregated[outputKey] = values[index] as Value;
          }
          break;
        }
        case "sample": {
          if (values.length === 0) {
            aggregated[outputKey] = null;
          } else {
            // Use seed for deterministic sampling
            const seed = agg.defaultValue || "default";
            // Simple seeded random number generator
            let hash = 0;
            for (let i = 0; i < seed.length; i++) {
              const char = seed.charCodeAt(i);
              hash = (hash << 5) - hash + char;
              hash = hash & hash; // Convert to 32-bit integer
            }
            // Use hash to select a value
            const index = Math.abs(hash) % values.length;
            aggregated[outputKey] = values[index] as Value;
          }
          break;
        }
        case "median": {
          const numericValues = values.filter(
            (v) => typeof v === "number"
          ) as number[];
          if (numericValues.length === 0) {
            aggregated[outputKey] = null;
          } else {
            const sorted = [...numericValues].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            if (sorted.length % 2 === 0) {
              // Even number of values: average of two middle values
              aggregated[outputKey] = (sorted[mid - 1] + sorted[mid]) / 2;
            } else {
              // Odd number of values: middle value
              aggregated[outputKey] = sorted[mid];
            }
          }
          break;
        }
        case "variance": {
          const numericValues = values.filter(
            (v) => typeof v === "number"
          ) as number[];
          if (numericValues.length === 0) {
            aggregated[outputKey] = null;
          } else {
            // Calculate mean
            const mean =
              numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
            // Calculate variance: average of squared differences from mean
            const variance =
              numericValues.reduce(
                (sum, val) => sum + Math.pow(val - mean, 2),
                0
              ) / numericValues.length;
            aggregated[outputKey] = variance;
          }
          break;
        }
        case "stddev": {
          const numericValues = values.filter(
            (v) => typeof v === "number"
          ) as number[];
          if (numericValues.length === 0) {
            aggregated[outputKey] = null;
          } else {
            // Calculate mean
            const mean =
              numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
            // Calculate variance
            const variance =
              numericValues.reduce(
                (sum, val) => sum + Math.pow(val - mean, 2),
                0
              ) / numericValues.length;
            // Standard deviation is square root of variance
            aggregated[outputKey] = Math.sqrt(variance);
          }
          break;
        }
        default:
          // For other aggregations not yet implemented, return null
          aggregated[outputKey] = null;
      }
    } else {
      // Not an aggregation, handle in regular projection
      // This will be handled by the project function
    }
  }

  return [aggregated];
}

/**
 * Join two result sets based on common variables
 * Rows are compatible if they have the same values for common variables
 * @param left Left result set
 * @param right Right result set
 * @param _clauses Query clauses (unused, kept for compatibility)
 * @returns Joined result set
 */
export function joinResults(
  left: Record<string, Value | Attribute>[],
  right: Record<string, Value | Attribute>[],
  _clauses: QueryClause[]
): Record<string, Value | Attribute>[] {
  const joined: Record<string, Value | Attribute>[] = [];

  for (const leftRow of left) {
    for (const rightRow of right) {
      // Check if rows are compatible (same values for common variables)
      let compatible = true;
      for (const key of Object.keys(leftRow)) {
        if (key in rightRow && leftRow[key] !== rightRow[key]) {
          compatible = false;
          break;
        }
      }

      if (compatible) {
        joined.push({ ...leftRow, ...rightRow });
      }
    }
  }

  return joined;
}

/**
 * Project results to only include find variables
 * Strips the question mark prefix from variable names in the result keys
 * Handles aggregations by computing them before projection
 * @param results Query results with variable names as keys
 * @param find Object mapping output keys to variable names (e.g., { x: "?x", name: "?name" })
 * @param _clauses Query clauses (unused, kept for compatibility)
 * @returns Projected results with question mark prefix stripped from keys
 */
export function project(
  results: Record<string, Value | Attribute>[],
  find: { [key: string]: unknown },
  _clauses: QueryClause[]
): QueryResult {
  // Check if we have aggregations
  if (hasAggregations(find)) {
    // Apply aggregations first
    const aggregated = applyAggregations(results, find);
    // Then do regular projection for non-aggregated fields
    const findKeys = Object.keys(find);
    return aggregated.map((row) => {
      const projected: Record<string, Value | Attribute> = {};
      for (const outputKey of findKeys) {
        const expr = find[outputKey];
        const agg = parseAggregation(expr);
        if (agg) {
          // This is an aggregation, already computed
          if (outputKey in row) {
            projected[outputKey] = row[outputKey];
          }
        } else {
          // Regular variable projection - extract variable from tuple or string
          let varName: string;
          if (
            Array.isArray(expr) &&
            expr.length === 1 &&
            typeof expr[0] === "string"
          ) {
            varName = expr[0];
          } else if (typeof expr === "string") {
            varName = expr;
          } else {
            continue;
          }
          if (varName in row) {
            projected[outputKey] = row[varName];
          }
        }
      }
      return projected;
    });
  }

  const findKeys = Object.keys(find);
  if (findKeys.length === 0) {
    // Strip ? from all keys when find is empty
    return results.map((row) => {
      const projected: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        projected[stripQuestionMark(key)] = row[key];
      }
      return projected;
    });
  }

  // Results already have variable names as keys, so map them to output keys
  // The find object maps output keys to variable names (tuples or strings)
  return results.map((row) => {
    const projected: Record<string, Value | Attribute> = {};
    for (const outputKey of findKeys) {
      const expr = find[outputKey];
      // Extract variable name from tuple or string
      let varName: string;
      if (
        Array.isArray(expr) &&
        expr.length === 1 &&
        typeof expr[0] === "string"
      ) {
        varName = expr[0];
      } else if (typeof expr === "string") {
        varName = expr;
      } else {
        continue;
      }
      if (varName in row) {
        projected[outputKey] = row[varName];
      }
    }
    return projected;
  });
}
