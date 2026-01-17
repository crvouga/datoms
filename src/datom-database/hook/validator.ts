/**
 * Helper class for collecting validation errors in hooks
 * Provides a convenient API for building up error lists
 */

import type { Datom } from "../../types.js";
import { HookError } from "../datom-database.js";

/**
 * Helper class for collecting validation errors in hooks
 * @example
 * const validator = new HookValidator();
 * validator.assert(email.includes("@"), "Invalid email format", "INVALID_EMAIL", datom);
 * validator.assert(age > 0, "Age must be positive", "INVALID_AGE", datom);
 *
 * if (validator.hasErrors()) {
 *   return { tx, errors: validator.getErrors() };
 * }
 */
export class HookValidator {
  private errors: HookError[] = [];

  /**
   * Assert a condition and add an error if it fails
   * @param condition Condition to check
   * @param message Error message if condition fails
   * @param code Optional error code
   * @param datom Optional datom associated with the error
   */
  assert(
    condition: boolean,
    message: string,
    code?: string,
    datom?: Datom
  ): void {
    if (!condition) {
      this.errors.push({ message, code, datom });
    }
  }

  /**
   * Get all collected errors
   * @returns Array of errors, or undefined if no errors
   */
  getErrors(): HookError[] | undefined {
    return this.errors.length > 0 ? this.errors : undefined;
  }

  /**
   * Check if any errors have been collected
   * @returns True if there are errors
   */
  hasErrors(): boolean {
    return this.errors.length > 0;
  }
}
