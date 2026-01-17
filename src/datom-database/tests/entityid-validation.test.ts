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
      await db.transact([{ op: "add", e: 123, a: "name", v: "Alice" }]);
      const entity = await db.datoms({ e: 123, op: "add" });
      expect(entity).toHaveLength(1);
      expect(entity[0].e).toBe(123);
    });

    test("should work with string EntityIds", async () => {
      const { db } = f;
      await db.transact([{ op: "add", e: "user-123", a: "name", v: "Alice" }]);
      const entity = await db.datoms({ e: "user-123", op: "add" });
      expect(entity).toHaveLength(1);
      expect(entity[0].e).toBe("user-123");
    });
  });
});
