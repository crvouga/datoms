/**
 * Custom error classes for datom database operations
 * These provide more specific error handling than generic Error objects
 */

/**
 * Base error class for all datom database errors
 */
export class DatomDatabaseError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "DatomDatabaseError";
    Object.setPrototypeOf(this, DatomDatabaseError.prototype);
  }
}

/**
 * Error thrown when a uniqueness constraint is violated
 * @example
 * try {
 *   await db.add([[1, "email", "alice@example.com"]]);
 *   await db.add([[2, "email", "alice@example.com"]]); // Throws UniqueConstraintError
 * } catch (error) {
 *   if (error instanceof UniqueConstraintError) {
 *     // Handle uniqueness violation
 *   }
 * }
 */
export class UniqueConstraintError extends DatomDatabaseError {
  constructor(
    public readonly attribute: string,
    public readonly value: unknown,
    public readonly existingEntity: unknown
  ) {
    super(
      `Attribute "${attribute}" is unique, but value ${JSON.stringify(
        value
      )} already exists for entity ${String(existingEntity)}`,
      "UNIQUE_CONSTRAINT_VIOLATION"
    );
    this.name = "UniqueConstraintError";
    Object.setPrototypeOf(this, UniqueConstraintError.prototype);
  }
}

/**
 * Error thrown when a cardinality constraint is violated
 * @example
 * try {
 *   await db.add([[1, "email", "alice@example.com"]]);
 *   await db.add([[1, "email", "alice2@example.com"]]); // Throws CardinalityError if cardinality: "one"
 * } catch (error) {
 *   if (error instanceof CardinalityError) {
 *     // Handle cardinality violation
 *   }
 * }
 */
export class CardinalityError extends DatomDatabaseError {
  constructor(
    public readonly attribute: string,
    public readonly entity: unknown,
    public readonly reason:
      | "multiple_values_in_batch"
      | "existing_value_conflict"
  ) {
    const message =
      reason === "multiple_values_in_batch"
        ? `Attribute "${attribute}" has cardinality: one, but multiple values provided for entity "${String(
            entity
          )}" in the same transaction`
        : `Attribute "${attribute}" has cardinality: one, but entity "${String(
            entity
          )}" already has a value. Retract the existing value first.`;
    super(message, "CARDINALITY_VIOLATION");
    this.name = "CardinalityError";
    Object.setPrototypeOf(this, CardinalityError.prototype);
  }
}

/**
 * Error thrown when a type constraint is violated
 * @example
 * try {
 *   await db.add([[1, "age", "not-a-number"]]); // Throws TypeError if type: "number"
 * } catch (error) {
 *   if (error instanceof DatomTypeError) {
 *     // Handle type violation
 *   }
 * }
 */
export class DatomTypeError extends DatomDatabaseError {
  constructor(
    public readonly attribute: string,
    public readonly value: unknown,
    public readonly expectedType: string,
    public readonly actualType: string
  ) {
    super(
      `Attribute "${attribute}" expects type "${expectedType}", but got ${actualType}`,
      "TYPE_CONSTRAINT_VIOLATION"
    );
    this.name = "DatomTypeError";
    Object.setPrototypeOf(this, DatomTypeError.prototype);
  }
}

/**
 * Error thrown when a transaction conflict occurs
 * Useful for optimistic locking scenarios
 * @example
 * try {
 *   await db.transaction(async (tx) => {
 *     // Long-running transaction that conflicts with another
 *   });
 * } catch (error) {
 *   if (error instanceof TransactionConflictError) {
 *     // Retry the transaction
 *   }
 * }
 */
export class TransactionConflictError extends DatomDatabaseError {
  constructor(
    message: string,
    public readonly txId?: number,
    public readonly conflictingTxId?: number
  ) {
    super(message, "TRANSACTION_CONFLICT");
    this.name = "TransactionConflictError";
    Object.setPrototypeOf(this, TransactionConflictError.prototype);
  }
}

/**
 * Error thrown when a query would perform a full table scan without filters
 * @example
 * try {
 *   await db.query({}); // Throws QuerySafetyError
 * } catch (error) {
 *   if (error instanceof QuerySafetyError) {
 *     // Add filters or limit to the query
 *   }
 * }
 */
export class QuerySafetyError extends DatomDatabaseError {
  constructor(message: string) {
    super(message, "QUERY_SAFETY_VIOLATION");
    this.name = "QuerySafetyError";
    Object.setPrototypeOf(this, QuerySafetyError.prototype);
  }
}

/**
 * Error thrown when schema migration fails
 * @example
 * try {
 *   await db.migrate(2);
 * } catch (error) {
 *   if (error instanceof MigrationError) {
 *     // Handle migration failure
 *   }
 * }
 */
export class MigrationError extends DatomDatabaseError {
  constructor(
    message: string,
    public readonly version?: number,
    public readonly cause?: Error
  ) {
    super(message, "MIGRATION_ERROR");
    this.name = "MigrationError";
    Object.setPrototypeOf(this, MigrationError.prototype);
  }
}
