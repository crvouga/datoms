import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("DatomDatabase (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  test("should create a database", async () => {
    const { db } = f;
    const database = db;
    expect(database).toBeDefined();
  });

  test("should add datoms", async () => {
    const { db } = f;
    const tx = await db.add([
      [1, "name", "Alice"],
      [1, "age", 30],
    ]);

    expect(tx).toBeGreaterThanOrEqual(1);

    const entity = await db.getEntity(1);
    expect(entity).toHaveLength(2);
    const values = entity.map((d) => d.value);
    expect(values).toContain("Alice");
    expect(values).toContain(30);
  });

  test("should query datoms", async () => {
    const { db } = f;
    await db.add([
      [1, "name", "Alice"],
      [2, "name", "Bob"],
    ]);

    const results = await db.query({ attribute: "name" });
    expect(results).toHaveLength(2);
  });

  test("should retract datoms", async () => {
    const { db } = f;
    await db.add([[1, "name", "Alice"]]);
    await db.retract([[1, "name", "Alice"]]);

    const entity = await db.getEntity(1);
    expect(entity).toHaveLength(0);
  });

  test("should get value for entity-attribute", async () => {
    const { db } = f;
    await db.add([[1, "name", "Alice"]]);

    const name = await db.getValue(1, "name");
    expect(name).toBe("Alice");
  });
});
