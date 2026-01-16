/**
 * Shared helper functions for Datalog query processing
 * These utilities are used across all database implementations
 */

/**
 * Check if a value is a variable (starts with ?)
 * @param value Value to check
 * @returns True if the value is a Datalog variable
 */
export function isVariable(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("?");
}

/**
 * Strip the question mark prefix from a variable name
 * @param key Variable name (e.g., "?x" or "x")
 * @returns Variable name without the question mark prefix (e.g., "x")
 */
export function stripQuestionMark(key: string): string {
  return key.startsWith("?") ? key.slice(1) : key;
}
