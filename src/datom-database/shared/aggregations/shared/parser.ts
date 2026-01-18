/**
 * Parser for aggregation expressions
 */

import { IN_MEMORY_AGGREGATIONS } from "../in-memory/registry.js";

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
      const def = IN_MEMORY_AGGREGATIONS.get(funcName);
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
      const def = IN_MEMORY_AGGREGATIONS.get(funcName);
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
  const def = IN_MEMORY_AGGREGATIONS.get(funcName);

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
