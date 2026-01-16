import { test, expect, describe } from "bun:test";
import { Database, MemoryBackend } from "../index";

describe("Database", () => {
  test("should create a database with memory backend", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    expect(db).toBeDefined();
    await db.close();
  });

  test("should add datoms", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    const tx = await db.add([
      [1, "name", "Alice"],
      [1, "age", 30],
    ]);

    expect(tx).toBe(1);

    const entity = await db.getEntity(1);
    expect(entity).toHaveLength(2);
    expect(entity[0].value).toBe("Alice");
    expect(entity[1].value).toBe(30);

    await db.close();
  });

  test("should query datoms", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      [1, "name", "Alice"],
      [2, "name", "Bob"],
    ]);

    const results = await db.query({ attribute: "name" });
    expect(results).toHaveLength(2);

    await db.close();
  });

  test("should retract datoms", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([[1, "name", "Alice"]]);
    await db.retract([[1, "name", "Alice"]]);

    const entity = await db.getEntity(1);
    expect(entity).toHaveLength(0);

    await db.close();
  });

  test("should get value for entity-attribute", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([[1, "name", "Alice"]]);

    const name = await db.getValue(1, "name");
    expect(name).toBe("Alice");

    await db.close();
  });
});
