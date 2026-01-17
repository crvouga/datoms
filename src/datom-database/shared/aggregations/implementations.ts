/**
 * Aggregation function implementations
 */

import type { Attribute, Value } from "../../../types.js";
import { registerAggregation } from "./registry.js";

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
