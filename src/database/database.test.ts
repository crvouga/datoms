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
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 1, attribute: "age", value: 30 },
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
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
    ]);

    const results = await db.query({ attribute: "name" });
    expect(results).toHaveLength(2);

    await db.close();
  });

  test("should retract datoms", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([{ entity: 1, attribute: "name", value: "Alice" }]);
    await db.retract([{ entity: 1, attribute: "name", value: "Alice" }]);

    const entity = await db.getEntity(1);
    expect(entity).toHaveLength(0);

    await db.close();
  });

  test("should get value for entity-attribute", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([{ entity: 1, attribute: "name", value: "Alice" }]);

    const name = await db.getValue(1, "name");
    expect(name).toBe("Alice");

    await db.close();
  });
});
