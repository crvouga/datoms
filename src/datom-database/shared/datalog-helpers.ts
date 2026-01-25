/**
 * Shared helper functions for Datalog query processing
 * These utilities are used across all database implementations
 */

import type {DatalogQueryWhereClause, DatalogQueryWhereClauseMatch} from '../../datalog-query.js';

/**
 * Check if a value is a variable (starts with ?)
 * @param value Value to check
 * @returns True if the value is a Datalog variable
 */
export function isVariable(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('?');
}

/**
 * Type guard to check if a QueryClause is a QueryPattern
 * @param clause Query clause to check
 * @returns True if the clause is a QueryPattern
 */
export function isQueryPattern(
  clause: DatalogQueryWhereClause,
): clause is DatalogQueryWhereClauseMatch {
  return (
    typeof clause === 'object' &&
    clause !== null &&
    'e' in clause &&
    !('or' in clause) &&
    !('not' in clause)
  );
}

/**
 * Strip the question mark prefix from a variable name
 * @param key Variable name (e.g., "?x" or "x")
 * @returns Variable name without the question mark prefix (e.g., "x")
 */
export function stripQuestionMark(key: string): string {
  return key.startsWith('?') ? key.slice(1) : key;
}
