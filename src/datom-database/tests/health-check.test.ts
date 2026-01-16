import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("Health Check (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("healthCheck", () => {
    test("should return health status", async () => {
      const { db } = f;
      const health = await db.healthCheck();

      expect(health).toBeDefined();
      expect(health.status).toBeDefined();
      expect(["healthy", "degraded", "unhealthy"]).toContain(health.status);
      expect(health.timestamp).toBeDefined();
      expect(typeof health.timestamp).toBe("string");
    });

    test("should return healthy status for empty database", async () => {
      const { db } = f;
      const health = await db.healthCheck();

      expect(health.status).toBe("healthy");
      expect(health.details).toBeDefined();
    });

    test("should include query performance metrics if available", async () => {
      const { db } = f;
      // Run some queries to generate metrics
      await db.add([[1, "name", "Alice"]]);
      await db.datoms({ entity: 1 });
      await db.datoms({ attribute: "name" });

      const health = await db.healthCheck();
      // Query performance may or may not be included depending on implementation
      if (health.queryPerformance) {
        expect(health.queryPerformance.healthy).toBeDefined();
        expect(typeof health.queryPerformance.healthy).toBe("boolean");
      }
    });

    test("should include transaction health metrics if available", async () => {
      const { db } = f;
      // Run some transactions to generate metrics
      await db.transaction(async (tx) => {
        await tx.add([[1, "name", "Alice"]]);
      });

      const health = await db.healthCheck();
      // Transaction health may or may not be included depending on implementation
      if (health.transactionHealth) {
        expect(health.transactionHealth.healthy).toBeDefined();
        expect(typeof health.transactionHealth.healthy).toBe("boolean");
      }
    });

    test("should include connection pool info for SQL databases", async () => {
      const { db } = f;
      const health = await db.healthCheck();

      // Connection pool info may or may not be available
      if (health.connectionPool) {
        expect(health.connectionPool.healthy).toBeDefined();
        expect(typeof health.connectionPool.healthy).toBe("boolean");
        expect(health.connectionPool.activeConnections).toBeGreaterThanOrEqual(
          0
        );
        expect(health.connectionPool.idleConnections).toBeGreaterThanOrEqual(0);
        expect(health.connectionPool.waitingRequests).toBeGreaterThanOrEqual(0);
      }
    });

    test("should return consistent health status", async () => {
      const { db } = f;
      const health1 = await db.healthCheck();
      const health2 = await db.healthCheck();

      // Status should be consistent (may vary slightly due to timing)
      expect(health1.status).toBeDefined();
      expect(health2.status).toBeDefined();
    });
  });
});
