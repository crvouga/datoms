/**
 * Aggregation function implementations
 */

import type { Attribute, Value } from "../../../types.js";
import { registerAggregation } from "./registry.js";

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

  // Random aggregation (rand N ?var) - returns N random values with replacement
  // Can return duplicates
  registerAggregation("rand", {
    compute: (values, countStr) => {
      if (values.length === 0) {
        return null;
      }
      const count = countStr ? parseInt(countStr, 10) : 1;
      if (isNaN(count) || count <= 0) {
        return null;
      }

      // Generate N random values with replacement
      const result: (Value | Attribute)[] = [];
      for (let i = 0; i < count; i++) {
        const randomIndex = Math.floor(Math.random() * values.length);
        result.push(values[randomIndex]);
      }

      // If count is 1, return single value; otherwise return array
      return (count === 1 ? result[0] : result) as Value;
    },
    supportsDefault: false,
    requiresSeed: true, // Uses requiresSeed flag to indicate it needs the count parameter
  });

  // Sample aggregation (sample N ?var) - returns N random values without replacement
  // No duplicates, returns array if N > 1
  registerAggregation("sample", {
    compute: (values, countStr) => {
      if (values.length === 0) {
        return null;
      }
      const count = countStr ? parseInt(countStr, 10) : 1;
      if (isNaN(count) || count <= 0) {
        return null;
      }

      // If count >= values.length, return all values
      if (count >= values.length) {
        return (count === 1 ? values[0] : values) as Value;
      }

      // Sample N random values without replacement (Fisher-Yates shuffle)
      const shuffled = [...values];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const sampled = shuffled.slice(0, count);

      // If count is 1, return single value; otherwise return array
      return (count === 1 ? sampled[0] : sampled) as Value;
    },
    supportsDefault: false,
    requiresSeed: true, // Uses requiresSeed flag to indicate it needs the count parameter
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
