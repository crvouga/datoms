import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CardinalityError,
  DatomTypeError,
  MigrationError,
  QuerySafetyError,
  TransactionConflictError,
  UniqueConstraintError,
} from "../errors.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("Custom Errors (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("UniqueConstraintError", () => {
    test("should throw UniqueConstraintError when adding duplicate unique values", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "email",
        cardinality: "one",
        type: "string",
        unique: true,
      });

      await db.add([[1, "email", "alice@example.com"]]);

      try {
        await db.add([[2, "email", "alice@example.com"]]);
        throw new Error("Should have thrown UniqueConstraintError");
      } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintError);
        const uniqueError = error as UniqueConstraintError;
        expect(uniqueError.attribute).toBe("email");
        expect(uniqueError.value).toBe("alice@example.com");
        expect(uniqueError.existingEntity).toBe(1);
        expect(uniqueError.code).toBe("UNIQUE_CONSTRAINT_VIOLATION");
        expect(uniqueError.name).toBe("UniqueConstraintError");
      }
    });

    test("should throw UniqueConstraintError in batch operations", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "email",
        cardinality: "one",
        type: "string",
        unique: true,
      });

      await db.add([[1, "email", "alice@example.com"]]);

      try {
        // Use add() directly which validates - this tests batch uniqueness checking
        await db.add([
          [2, "email", "alice@example.com"], // Duplicate - should fail
          [3, "email", "bob@example.com"],
        ]);
        throw new Error("Should have thrown UniqueConstraintError");
      } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintError);
        const uniqueError = error as UniqueConstraintError;
        expect(uniqueError.attribute).toBe("email");
        expect(uniqueError.value).toBe("alice@example.com");
        expect(uniqueError.existingEntity).toBe(1);
      }
    });
  });

  describe("CardinalityError", () => {
    test("should throw CardinalityError when adding multiple values in same batch", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "email",
        cardinality: "one",
        type: "string",
      });

      try {
        await db.add([
          [1, "email", "alice@example.com"],
          [1, "email", "alice2@example.com"],
        ]);
        throw new Error("Should have thrown CardinalityError");
      } catch (error) {
        expect(error).toBeInstanceOf(CardinalityError);
        const cardinalityError = error as CardinalityError;
        expect(cardinalityError.attribute).toBe("email");
        expect(cardinalityError.entity).toBe("1");
        expect(cardinalityError.reason).toBe("multiple_values_in_batch");
        expect(cardinalityError.code).toBe("CARDINALITY_VIOLATION");
        expect(cardinalityError.name).toBe("CardinalityError");
      }
    });

    test("should throw CardinalityError when entity already has a value", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "email",
        cardinality: "one",
        type: "string",
      });

      await db.add([[1, "email", "alice@example.com"]]);

      try {
        await db.add([[1, "email", "alice2@example.com"]]);
        throw new Error("Should have thrown CardinalityError");
      } catch (error) {
        expect(error).toBeInstanceOf(CardinalityError);
        const cardinalityError = error as CardinalityError;
        expect(cardinalityError.attribute).toBe("email");
        expect(cardinalityError.entity).toBe("1");
        expect(cardinalityError.reason).toBe("existing_value_conflict");
        expect(cardinalityError.code).toBe("CARDINALITY_VIOLATION");
      }
    });
  });

  describe("DatomTypeError", () => {
    test("should throw DatomTypeError for string type violation", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "name",
        cardinality: "one",
        type: "string",
      });

      try {
        await db.add([[1, "name", 123]]);
        throw new Error("Should have thrown DatomTypeError");
      } catch (error) {
        expect(error).toBeInstanceOf(DatomTypeError);
        const typeError = error as DatomTypeError;
        expect(typeError.attribute).toBe("name");
        expect(typeError.value).toBe(123);
        expect(typeError.expectedType).toBe("string");
        expect(typeError.actualType).toBe("number");
        expect(typeError.code).toBe("TYPE_CONSTRAINT_VIOLATION");
        expect(typeError.name).toBe("DatomTypeError");
      }
    });

    test("should throw DatomTypeError for number type violation", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "age",
        cardinality: "one",
        type: "number",
      });

      try {
        await db.add([[1, "age", "not-a-number"]]);
        throw new Error("Should have thrown DatomTypeError");
      } catch (error) {
        expect(error).toBeInstanceOf(DatomTypeError);
        const typeError = error as DatomTypeError;
        expect(typeError.attribute).toBe("age");
        expect(typeError.value).toBe("not-a-number");
        expect(typeError.expectedType).toBe("number");
        expect(typeError.actualType).toBe("string");
      }
    });

    test("should throw DatomTypeError for boolean type violation", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "active",
        cardinality: "one",
        type: "boolean",
      });

      try {
        await db.add([[1, "active", "true"]]);
        throw new Error("Should have thrown DatomTypeError");
      } catch (error) {
        expect(error).toBeInstanceOf(DatomTypeError);
        const typeError = error as DatomTypeError;
        expect(typeError.attribute).toBe("active");
        expect(typeError.expectedType).toBe("boolean");
        expect(typeError.actualType).toBe("string");
      }
    });

    test("should throw DatomTypeError for date type violation", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "created",
        cardinality: "one",
        type: "date",
      });

      try {
        await db.add([[1, "created", 12345]]);
        throw new Error("Should have thrown DatomTypeError");
      } catch (error) {
        expect(error).toBeInstanceOf(DatomTypeError);
        const typeError = error as DatomTypeError;
        expect(typeError.attribute).toBe("created");
        expect(typeError.expectedType).toBe("date");
        expect(typeError.actualType).toBe("number");
      }
    });

    test("should throw DatomTypeError for invalid date string", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "created",
        cardinality: "one",
        type: "date",
      });

      try {
        await db.add([[1, "created", "not-a-date"]]);
        throw new Error("Should have thrown DatomTypeError");
      } catch (error) {
        expect(error).toBeInstanceOf(DatomTypeError);
        const typeError = error as DatomTypeError;
        expect(typeError.attribute).toBe("created");
        expect(typeError.value).toBe("not-a-date");
      }
    });

    test("should throw DatomTypeError for ref type violation", async () => {
      const { db } = f;
      await db.defineAttribute({
        name: "parent",
        cardinality: "one",
        type: "ref",
      });

      try {
        // Use null as invalid ref (ref should be EntityId: number, string, or symbol)
        await db.add([[1, "parent", null as any]]);
        throw new Error("Should have thrown DatomTypeError");
      } catch (error) {
        expect(error).toBeInstanceOf(DatomTypeError);
        const typeError = error as DatomTypeError;
        expect(typeError.attribute).toBe("parent");
        expect(typeError.expectedType).toBe("ref");
        expect(typeError.actualType).toBe("object");
      }
    });
  });

  describe("QuerySafetyError", () => {
    test("should throw QuerySafetyError for query without filters or limits", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      try {
        await db.query({});
        throw new Error("Should have thrown QuerySafetyError");
      } catch (error) {
        expect(error).toBeInstanceOf(QuerySafetyError);
        const safetyError = error as QuerySafetyError;
        expect(safetyError.code).toBe("QUERY_SAFETY_VIOLATION");
        expect(safetyError.name).toBe("QuerySafetyError");
        expect(safetyError.message).toContain("filter");
      }
    });

    test("should throw QuerySafetyError for history query without filters or limits", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);

      try {
        await db.queryHistory({});
        throw new Error("Should have thrown QuerySafetyError");
      } catch (error) {
        expect(error).toBeInstanceOf(QuerySafetyError);
        const safetyError = error as QuerySafetyError;
        expect(safetyError.code).toBe("QUERY_SAFETY_VIOLATION");
        expect(safetyError.message).toContain("History query");
      }
    });
  });

  describe("TransactionConflictError", () => {
    test("should throw TransactionConflictError when optimistic lock fails", async () => {
      const { db } = f;
      await db.add([[1, "name", "Alice"]]);
      const initialTx = await db.getLatestTransaction();

      // First transaction updates the database
      await db.add([[2, "name", "Bob"]]);

      // Second transaction expects old txId
      try {
        await db.transaction(
          async (tx) => {
            await tx.add([[3, "name", "Charlie"]]);
          },
          { expectedTxId: initialTx }
        );
        throw new Error("Should have thrown TransactionConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(TransactionConflictError);
        const conflictError = error as TransactionConflictError;
        expect(conflictError.code).toBe("TRANSACTION_CONFLICT");
        expect(conflictError.name).toBe("TransactionConflictError");
        expect(conflictError.txId).toBe(initialTx);
        expect(conflictError.conflictingTxId).toBeGreaterThan(initialTx);
        expect(conflictError.message).toContain("conflict");
      }
    });
  });

  describe("MigrationError", () => {
    test("should throw MigrationError when attempting backward migration", async () => {
      const { db } = f;
      // Set initial version
      await db.migrate(5);
      const version = await db.getSchemaVersion();
      expect(version).toBe(5);

      try {
        await db.migrate(3);
        throw new Error("Should have thrown MigrationError");
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationError);
        const migrationError = error as MigrationError;
        expect(migrationError.code).toBe("MIGRATION_ERROR");
        expect(migrationError.name).toBe("MigrationError");
        expect(migrationError.version).toBe(3);
        expect(migrationError.message).toContain("backwards");
      }
    });
  });
});
