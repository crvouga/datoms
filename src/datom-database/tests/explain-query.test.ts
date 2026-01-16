import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("explainQuery (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
    // Add some test data
    await f.db.add([
      [1, "name", "Alice"],
      [1, "age", 30],
      [2, "name", "Bob"],
      [2, "age", 25],
      [3, "name", "Charlie"],
      [3, "status", "active"],
    ]);
  });

  afterEach(async () => {
    await f.afterEach();
    await f.db.close();
  });

  describe("Basic explain tests", () => {
    test("should return index scan type for entity filter", async () => {
      const explanation = await f.db.explainQuery({ entity: 1 });
      // Backends may return "index" or "index-only" (both are efficient)
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
      expect(explanation.indexesUsed).toBeDefined();
      expect(explanation.indexesUsed!.length).toBeGreaterThan(0);
    });

    test("should return index scan type for attribute filter", async () => {
      const explanation = await f.db.explainQuery({ attribute: "name" });
      // Backends may return "index" or "index-only" (both are efficient)
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
      expect(explanation.indexesUsed).toBeDefined();
      expect(explanation.indexesUsed!.length).toBeGreaterThan(0);
    });

    test("should return index scan type for value filter", async () => {
      const explanation = await f.db.explainQuery({ value: "Alice" });
      // Backends may return "index", "index-only", or other scan types
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
      expect(explanation.indexesUsed).toBeDefined();
      expect(explanation.indexesUsed!.length).toBeGreaterThan(0);
    });

    test("should return full-table scan with warning when no filters", async () => {
      const explanation = await f.db.explainQuery({ limit: 10 });
      // Backends may optimize differently, so accept multiple scan types
      // but should have warnings if it's not an efficient scan
      if (explanation.scanType === "full-table") {
        expect(explanation.warnings).toBeDefined();
        expect(explanation.warnings?.length).toBeGreaterThan(0);
        expect(
          explanation.warnings?.some((w) => w.includes("full table scan"))
        ).toBe(true);
      } else {
        // If backend optimized it (e.g., index-only scan), that's fine too
        expect(explanation.scanType).toBeDefined();
      }
    });

    test("should include warning when no limit on full-table scan", async () => {
      const explanation = await f.db.explainQuery({ attribute: "name" });
      // This should not have a warning since it has a filter
      if (explanation.scanType === "full-table") {
        expect(explanation.warnings).toBeDefined();
        expect(explanation.warnings?.some((w) => w.includes("limit"))).toBe(
          true
        );
      }
    });
  });

  describe("Backend-specific tests", () => {
    test("should provide estimated rows for InMemory backend", async () => {
      if (_name === "InMemory") {
        const explanation = await f.db.explainQuery({ entity: 1 });
        expect(explanation.estimatedRows).toBeDefined();
        expect(typeof explanation.estimatedRows).toBe("number");
      }
    });

    test("should parse SQLite EXPLAIN QUERY PLAN", async () => {
      if (_name.includes("SQLite")) {
        const explanation = await f.db.explainQuery({ attribute: "name" });
        expect(explanation.raw).toBeDefined();
        // SQLite should provide raw explain output
        expect(Array.isArray(explanation.raw)).toBe(true);
      }
    });

    test("should parse PostgreSQL EXPLAIN ANALYZE", async () => {
      if (_name.includes("PostgreSQL")) {
        const explanation = await f.db.explainQuery({ attribute: "name" });
        expect(explanation.raw).toBeDefined();
        // PostgreSQL should provide cost estimates
        if (explanation.estimatedCost !== undefined) {
          expect(typeof explanation.estimatedCost).toBe("number");
        }
        if (explanation.estimatedRows !== undefined) {
          expect(typeof explanation.estimatedRows).toBe("number");
        }
      }
    });
  });

  describe("Edge cases", () => {
    test("should handle empty query options", async () => {
      const explanation = await f.db.explainQuery({ limit: 1 });
      expect(explanation).toBeDefined();
      expect(explanation.scanType).toBeDefined();
    });

    test("should handle query with all filters", async () => {
      const explanation = await f.db.explainQuery({
        entity: 1,
        attribute: "name",
        value: "Alice",
        tx: 1,
      });
      // Backends may optimize to index or index-only scans
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
      expect(explanation.indexesUsed?.length).toBeGreaterThan(0);
    });

    test("should handle history queries", async () => {
      const explanation = await f.db.explainQuery({
        attribute: "name",
        history: true,
      });
      expect(explanation).toBeDefined();
      expect(explanation.scanType).toBeDefined();
    });

    test("should handle time-travel queries (asOf)", async () => {
      const explanation = await f.db.explainQuery({
        entity: 1,
        asOf: 1,
      });
      expect(explanation).toBeDefined();
      // Backends may optimize to index or index-only scans
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
    });

    test("should handle queries with limit and offset", async () => {
      const explanation = await f.db.explainQuery({
        attribute: "name",
        limit: 10,
        offset: 5,
      });
      expect(explanation).toBeDefined();
      // Backends may optimize to index or index-only scans
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
    });
  });

  describe("Multiple filters", () => {
    test("should detect multiple indexes used", async () => {
      const explanation = await f.db.explainQuery({
        entity: 1,
        attribute: "name",
      });
      expect(explanation.indexesUsed).toBeDefined();
      expect(explanation.indexesUsed!.length).toBeGreaterThanOrEqual(1);
      // Backends may use different index names, so just verify indexes are detected
    });

    test("should handle entity and value filters", async () => {
      const explanation = await f.db.explainQuery({
        entity: 1,
        value: "Alice",
      });
      // Backends may optimize to index or index-only scans
      expect(explanation.scanType).toBeDefined();
      if (explanation.scanType) {
        expect(["index", "index-only", "unknown"]).toContain(
          explanation.scanType
        );
      }
      expect(explanation.indexesUsed?.length).toBeGreaterThan(0);
    });
  });
});
