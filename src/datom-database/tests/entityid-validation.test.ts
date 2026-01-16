import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InMemoryDatomDatabase } from "../datom-database-in-memory.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("EntityId Validation (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("validateEntityId", () => {
    test("should validate number EntityIds", () => {
      const { db } = f;
      expect(db.validateEntityId(123)).toBe(true);
      expect(db.validateEntityId(0)).toBe(true);
      expect(db.validateEntityId(-1)).toBe(true);
    });

    test("should validate string EntityIds", () => {
      const { db } = f;
      expect(db.validateEntityId("user-123")).toBe(true);
      expect(db.validateEntityId("")).toBe(true);
    });

    test("should validate symbol EntityIds", () => {
      const { db } = f;
      const sym = Symbol("test");
      expect(db.validateEntityId(sym)).toBe(true);
    });

    test("should throw error for invalid EntityIds", () => {
      const { db } = f;
      try {
        db.validateEntityId(null);
        throw new Error("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Invalid EntityId");
      }

      try {
        db.validateEntityId(undefined);
        throw new Error("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }

      try {
        db.validateEntityId({});
        throw new Error("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe("EntityId serialization", () => {
    test("should serialize and deserialize number EntityIds", () => {
      const { db } = f;
      const entityId = 123;

      const serialized = db.serializeEntityId(entityId);
      expect(serialized).toBe("123");

      const deserialized = db.deserializeEntityId(serialized);

      expect(deserialized).toBe(123);
    });

    test("should serialize and deserialize string EntityIds", () => {
      const { db } = f;
      const entityId = "user-123";
      const serialized = db.serializeEntityId(entityId);
      expect(serialized).toBe("user-123");

      const deserialized = db.deserializeEntityId(serialized);
      expect(deserialized).toBe("user-123");
    });

    test("should serialize and deserialize symbol EntityIds", () => {
      const { db } = f;
      const entityId = Symbol("test-symbol");
      const serialized = db.serializeEntityId(entityId);
      expect(serialized).toBe("__SYMBOL__test-symbol");

      const deserialized = db.deserializeEntityId(serialized);
      expect(typeof deserialized).toBe("symbol");
      // Verify the symbol description matches
      expect(typeof deserialized === "symbol" && deserialized.description).toBe(
        "test-symbol"
      );
      expect(String(deserialized)).toBe("Symbol(test-symbol)");
    });

    test("should handle numeric strings correctly", () => {
      const { db } = f;
      // Numeric strings should be parsed as numbers
      const deserialized = db.deserializeEntityId("123");
      expect(deserialized).toBe(123);
      expect(typeof deserialized).toBe("number");
    });

    test("should handle non-numeric strings as strings", () => {
      const { db } = f;
      const deserialized = db.deserializeEntityId("abc123");
      expect(deserialized).toBe("abc123");
      expect(typeof deserialized).toBe("string");
    });
  });

  describe("EntityId usage", () => {
    test("should work with number EntityIds", async () => {
      const { db } = f;
      await db.add([[123, "name", "Alice"]]);
      const entity = await db.getEntity(123);
      expect(entity).toHaveLength(1);
      expect(entity[0].entity).toBe(123);
    });

    test("should work with string EntityIds", async () => {
      const { db } = f;
      await db.add([["user-123", "name", "Alice"]]);
      const entity = await db.getEntity("user-123");
      expect(entity).toHaveLength(1);
      expect(entity[0].entity).toBe("user-123");
    });

    test("should work with symbol EntityIds", async () => {
      const { db } = f;
      const sym = Symbol("test-entity");
      await db.add([[sym, "name", "Alice"]]);
      const entity = await db.getEntity(sym);
      expect(entity).toHaveLength(1);
      // Symbols are recreated on deserialization, so compare descriptions
      expect(typeof entity[0].entity).toBe("symbol");
      const e = entity[0].entity;
      expect(typeof e === "symbol" && e.description).toBe("test-entity");
      expect(String(entity[0].entity)).toBe("Symbol(test-entity)");
    });
  });
});
