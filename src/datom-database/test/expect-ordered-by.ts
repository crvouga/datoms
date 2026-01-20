import {expect} from 'bun:test';

/**
 * Asserts that an array of objects is ordered by a specified field,
 * in either ascending ("asc") or descending ("desc") order.
 * If a `limit` is provided, only checks the first `limit` results.
 *
 * @template T - Type of object elements in results array.
 * @param {T[]} results - The array of objects to check for ordering.
 * @param {keyof T} field - The key on each object to compare for ordering.
 * @param {"asc" | "desc"} direction - The order to check: "asc" for ascending, "desc" for descending.
 * @param {number} [limit] - Optional limit for the number of items to check. If not provided, checks entire array.
 *
 * @throws AssertionError If the order of elements does not match the expected direction.
 */
export function expectOrderedBy<T extends Record<string, unknown>>(
  results: T[],
  field: keyof T,
  direction: 'asc' | 'desc',
  limit?: number,
): void {
  const checkLength = Math.min(limit ?? results.length, results.length);
  for (let i = 1; i < checkLength; i++) {
    const prevValue = results[i - 1]?.[field];
    const currValue = results[i]?.[field];
    expect(prevValue).toBeDefined();
    expect(currValue).toBeDefined();

    // Helper to check if a value can be treated as a valid number
    const getNumericValue = (val: unknown): number | null => {
      if (typeof val === 'number') {
        return val;
      }
      if (typeof val === 'string' && val !== '') {
        const parsed = Number(val);
        if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const prevNum = getNumericValue(prevValue);
    const currNum = getNumericValue(currValue);

    // If both are numeric, compare as numbers
    if (prevNum !== null && currNum !== null) {
      if (direction === 'desc') {
        expect(prevNum).toBeGreaterThanOrEqual(currNum);
      } else {
        expect(prevNum).toBeLessThanOrEqual(currNum);
      }
    } else {
      // At least one is not numeric, use locale-aware string comparison
      // This matches the database's sorting behavior
      const prevStr = String(prevValue);
      const currStr = String(currValue);
      const comparison = prevStr.localeCompare(currStr);

      if (direction === 'desc') {
        expect(comparison).toBeGreaterThanOrEqual(0);
      } else {
        expect(comparison).toBeLessThanOrEqual(0);
      }
    }
  }
}
