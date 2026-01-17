/**
 * Shared query processing functions for Datalog queries
 * These utilities are used across all database implementations
 */

import type { QueryClause, QueryResult } from "../../datalog/datalog.js";
import type { Attribute, Value } from "../../types.js";
import { stripQuestionMark } from "./datalog-helpers.js";

/**
 * Aggregation function that computes a value from an array of values
 */
type AggregationFunction = (
  values: (Value | Attribute)[],
  defaultValue?: string
) => Value | Attribute | null;

/**
 * Aggregation definition
 */
interface AggregationDefinition {
  /** Function to compute the aggregation */
  compute: AggregationFunction;
  /** Whether this aggregation supports a default value */
  supportsDefault: boolean;
  /** Whether this aggregation requires a seed/default value */
  requiresSeed: boolean;
}

/**
 * Registry of all aggregation functions
 */
const AGGREGATION_REGISTRY: Map<string, AggregationDefinition> = new Map();

/**
 * Register an aggregation function
 */
function registerAggregation(
  name: string,
  definition: AggregationDefinition
): void {
  AGGREGATION_REGISTRY.set(name, definition);
}

/**
 * Get aggregation definition
 */
function getAggregationDefinition(
  name: string
): AggregationDefinition | undefined {
  return AGGREGATION_REGISTRY.get(name);
}

/**
 * Helper function to generate a seeded hash for deterministic randomness
 */
function seededHash(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Register all aggregation implementations
 */
function registerAllAggregations(): void {
  // Count aggregation
  registerAggregation("count", {
    compute: (values) => values.length,
    supportsDefault: false,
    requiresSeed: false,
  });

  // Count distinct aggregation
  registerAggregation("count-distinct", {
    compute: (values) => {
      const distinct = new Set(values.map((v) => JSON.stringify(v)));
      return distinct.size;
    },
    supportsDefault: false,
    requiresSeed: false,
  });

  // Sum aggregation
  registerAggregation("sum", {
    compute: (values) => {
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      return numericValues.reduce((a, b) => a + b, 0);
    },
    supportsDefault: false,
    requiresSeed: false,
  });

  // Average aggregation
  registerAggregation("avg", {
    compute: (values) => {
      if (values.length === 0) {
        return null;
      }
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      if (numericValues.length === 0) {
        return null;
      }
      const sum = numericValues.reduce((a, b) => a + b, 0);
      return sum / numericValues.length;
    },
    supportsDefault: false,
    requiresSeed: false,
  });

  // Min aggregation
  registerAggregation("min", {
    compute: (values, defaultValue) => {
      if (values.length === 0) {
        return defaultValue !== undefined ? defaultValue : null;
      }
      const filtered = values.filter(
        (v): v is Value | Attribute => v !== null && v !== undefined
      );
      if (filtered.length === 0) {
        return defaultValue !== undefined ? defaultValue : null;
      }
      return filtered.reduce((a, b) => {
        if (a === null || a === undefined || b === null || b === undefined) {
          return a ?? b ?? null;
        }
        return (a < b ? a : b) as Value;
      }) as Value;
    },
    supportsDefault: true,
    requiresSeed: false,
  });

  // Max aggregation
  registerAggregation("max", {
    compute: (values, defaultValue) => {
      if (values.length === 0) {
        return defaultValue !== undefined ? defaultValue : null;
      }
      const filtered = values.filter(
        (v): v is Value | Attribute => v !== null && v !== undefined
      );
      if (filtered.length === 0) {
        return defaultValue !== undefined ? defaultValue : null;
      }
      return filtered.reduce((a, b) => {
        if (a === null || a === undefined || b === null || b === undefined) {
          return a ?? b ?? null;
        }
        return (a > b ? a : b) as Value;
      }) as Value;
    },
    supportsDefault: true,
    requiresSeed: false,
  });

  // Distinct aggregation
  registerAggregation("distinct", {
    compute: (values) => {
      const distinct = Array.from(
        new Set(values.map((v) => JSON.stringify(v)))
      ).map((v) => JSON.parse(v) as Value);
      return distinct as unknown as Value;
    },
    supportsDefault: false,
    requiresSeed: false,
  });

  // Random aggregation (requires seed)
  registerAggregation("rand", {
    compute: (values, seed) => {
      if (values.length === 0) {
        return null;
      }
      const seedValue = seed || "default";
      const hash = seededHash(seedValue);
      const index = hash % values.length;
      return values[index] as Value;
    },
    supportsDefault: false,
    requiresSeed: true,
  });

  // Sample aggregation (requires seed)
  registerAggregation("sample", {
    compute: (values, seed) => {
      if (values.length === 0) {
        return null;
      }
      const seedValue = seed || "default";
      const hash = seededHash(seedValue);
      const index = hash % values.length;
      return values[index] as Value;
    },
    supportsDefault: false,
    requiresSeed: true,
  });

  // Median aggregation
  registerAggregation("median", {
    compute: (values) => {
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      if (numericValues.length === 0) {
        return null;
      }
      const sorted = [...numericValues].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        // Even number of values: average of two middle values
        return (sorted[mid - 1] + sorted[mid]) / 2;
      } else {
        // Odd number of values: middle value
        return sorted[mid];
      }
    },
    supportsDefault: false,
    requiresSeed: false,
  });

  // Variance aggregation
  registerAggregation("variance", {
    compute: (values) => {
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      if (numericValues.length === 0) {
        return null;
      }
      // Calculate mean
      const mean =
        numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      // Calculate variance: average of squared differences from mean
      const variance =
        numericValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
        numericValues.length;
      return variance;
    },
    supportsDefault: false,
    requiresSeed: false,
  });

  // Standard deviation aggregation
  registerAggregation("stddev", {
    compute: (values) => {
      const numericValues = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      if (numericValues.length === 0) {
        return null;
      }
      // Calculate mean
      const mean =
        numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      // Calculate variance
      const variance =
        numericValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
        numericValues.length;
      // Standard deviation is square root of variance
      return Math.sqrt(variance);
    },
    supportsDefault: false,
    requiresSeed: false,
  });
}

// Initialize all aggregations on module load
registerAllAggregations();

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
      const def = getAggregationDefinition(funcName);
      if (def && variable.startsWith("?")) {
        // Check if this aggregation requires a seed (should be 3-element array)
        if (def.requiresSeed) {
          return null; // Missing required seed
        }
        return { type: funcName, variable };
      }
    }
    if (expr.length === 3 && typeof expr[0] === "string") {
      // Aggregation with default/seed: ["max", "0", "?age"] or ["rand", "seed123", "?value"]
      const funcName = expr[0] as string;
      const defaultValue = expr[1] as string | number;
      const variable = expr[2] as string;
      const def = getAggregationDefinition(funcName);
      if (
        def &&
        (def.supportsDefault || def.requiresSeed) &&
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
  const def = getAggregationDefinition(funcName);

  if (!def) {
    return null;
  }

  // Handle functions with default values like "max(\"0\", ?age)"
  if (args) {
    const defaultMatch = args.match(/^"([^"]+)",\s*(\?[\w]+)$/);
    if (defaultMatch) {
      if (def.supportsDefault || def.requiresSeed) {
        return {
          type: funcName,
          variable: defaultMatch[2],
          defaultValue: defaultMatch[1],
        };
      }
    }
    // Handle functions with single argument like "avg(?age)"
    const varMatch = args.match(/^(\?[\w]+)$/);
    if (varMatch) {
      if (!def.requiresSeed) {
        return { type: funcName, variable: varMatch[1] };
      }
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

      const def = getAggregationDefinition(agg.type);
      if (def) {
        aggregated[outputKey] = def.compute(values, agg.defaultValue);
      } else {
        // Fallback for unregistered aggregations
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
