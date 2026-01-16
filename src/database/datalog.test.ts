import { test, expect, describe } from "bun:test";
import { Database, MemoryBackend, DatalogQueryEngine } from "../index";
import type { DatalogQuery } from "../index";

describe("DatalogQueryEngine", () => {
  test("should execute simple query", async () => {
    const backend = new MemoryBackend();
    const db = new Database(backend);
    await db.initialize();

    await db.add([
      { entity: 1, attribute: "name", value: "Alice" },
      { entity: 2, attribute: "name", value: "Bob" },
    ]);

    const engine = new DatalogQueryEngine(db);
    const query: DatalogQuery = {
      find: ["?x"],
      where: [{ entity: "?x", attribute: "name", value: "?y" }],
    };

    expect(query.find).toContain("?x");
    expect(query.where).toHaveLength(1);

    const results = await engine.query(query);
    expect(results).toHaveLength(2);
    expect(results[0]["?x"]).toBe(1);
    expect(results[1]["?x"]).toBe(2);

    await db.close();
  });
});
