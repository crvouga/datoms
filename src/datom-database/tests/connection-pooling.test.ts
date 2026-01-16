import { describe, expect, test } from "bun:test";

import type {
  ConnectionPoolConfig,
  ConnectionPoolStats,
} from "../../types.js";
import type { SQLDatabase } from "../../sql-database/sql-database.js";

describe("Connection Pooling Types", () => {
  describe("ConnectionPoolConfig", () => {
    test("should accept all optional fields", () => {
      const config: ConnectionPoolConfig = {
        maxConnections: 10,
        minConnections: 2,
        idleTimeout: 30000,
        connectionTimeout: 5000,
        maxLifetime: 3600000,
      };

      expect(config.maxConnections).toBe(10);
      expect(config.minConnections).toBe(2);
      expect(config.idleTimeout).toBe(30000);
      expect(config.connectionTimeout).toBe(5000);
      expect(config.maxLifetime).toBe(3600000);
    });

    test("should accept partial configuration", () => {
      const config: ConnectionPoolConfig = {
        maxConnections: 5,
      };

      expect(config.maxConnections).toBe(5);
      expect(config.minConnections).toBeUndefined();
    });

    test("should accept empty configuration", () => {
      const config: ConnectionPoolConfig = {};
      expect(config).toBeDefined();
    });
  });

  describe("ConnectionPoolStats", () => {
    test("should have all required fields", () => {
      const stats: ConnectionPoolStats = {
        activeConnections: 3,
        idleConnections: 2,
        totalConnections: 5,
        waitingRequests: 0,
      };

      expect(stats.activeConnections).toBe(3);
      expect(stats.idleConnections).toBe(2);
      expect(stats.totalConnections).toBe(5);
      expect(stats.waitingRequests).toBe(0);
    });

    test("should allow zero values", () => {
      const stats: ConnectionPoolStats = {
        activeConnections: 0,
        idleConnections: 0,
        totalConnections: 0,
        waitingRequests: 0,
      };

      expect(stats.activeConnections).toBe(0);
      expect(stats.totalConnections).toBe(0);
    });
  });

  describe("SQLDatabase interface", () => {
    test("getPoolStats() is optional", () => {
      // Create a mock SQLDatabase without getPoolStats
      const sqlDb: SQLDatabase = {
        query: async () => [],
        execute: async () => {},
      };

      expect(sqlDb.getPoolStats).toBeUndefined();
    });

    test("getPoolStats() can be implemented", async () => {
      const stats: ConnectionPoolStats = {
        activeConnections: 2,
        idleConnections: 3,
        totalConnections: 5,
        waitingRequests: 0,
      };

      const sqlDb: SQLDatabase = {
        query: async () => [],
        execute: async () => {},
        getPoolStats: async () => stats,
      };

      if (sqlDb.getPoolStats) {
        const result = await sqlDb.getPoolStats();
        expect(result).toEqual(stats);
        expect(result.activeConnections).toBe(2);
        expect(result.totalConnections).toBe(5);
      }
    });

    test("getPoolStats() returns valid ConnectionPoolStats", async () => {
      const sqlDb: SQLDatabase = {
        query: async () => [],
        execute: async () => {},
        getPoolStats: async () => ({
          activeConnections: 1,
          idleConnections: 4,
          totalConnections: 5,
          waitingRequests: 1,
        }),
      };

      if (sqlDb.getPoolStats) {
        const stats = await sqlDb.getPoolStats();
        expect(stats).toHaveProperty("activeConnections");
        expect(stats).toHaveProperty("idleConnections");
        expect(stats).toHaveProperty("totalConnections");
        expect(stats).toHaveProperty("waitingRequests");
        expect(typeof stats.activeConnections).toBe("number");
        expect(typeof stats.idleConnections).toBe("number");
        expect(typeof stats.totalConnections).toBe("number");
        expect(typeof stats.waitingRequests).toBe("number");
      }
    });
  });

  describe("Type validation", () => {
    test("ConnectionPoolConfig fields are all optional", () => {
      // This test verifies TypeScript compilation
      // If types are wrong, this won't compile
      const config1: ConnectionPoolConfig = {};
      const config2: ConnectionPoolConfig = { maxConnections: 10 };
      const config3: ConnectionPoolConfig = {
        maxConnections: 10,
        minConnections: 2,
        idleTimeout: 30000,
        connectionTimeout: 5000,
        maxLifetime: 3600000,
      };

      expect(config1).toBeDefined();
      expect(config2).toBeDefined();
      expect(config3).toBeDefined();
    });

    test("ConnectionPoolStats fields are all required", () => {
      // This test verifies TypeScript compilation
      // Missing fields should cause compilation errors
      const stats: ConnectionPoolStats = {
        activeConnections: 0,
        idleConnections: 0,
        totalConnections: 0,
        waitingRequests: 0,
      };

      expect(stats).toBeDefined();
      expect(stats.activeConnections).toBeDefined();
      expect(stats.idleConnections).toBeDefined();
      expect(stats.totalConnections).toBeDefined();
      expect(stats.waitingRequests).toBeDefined();
    });
  });
});
