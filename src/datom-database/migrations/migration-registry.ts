/**
 * Migration registry for managing database migrations
 * Provides discovery, execution, and rollback of migrations
 */

import type { Migration, MigrationState } from "../../types.js";
import { MigrationError, MigrationRollbackError } from "../errors.js";

/**
 * Migration registry for managing and executing migrations
 */
export class MigrationRegistry {
  private migrations: Map<number, Migration> = new Map();

  /**
   * Register a migration
   * @param migration Migration to register
   * @throws Error if migration version already exists
   */
  register(migration: Migration): void {
    if (this.migrations.has(migration.version)) {
      throw new Error(
        `Migration version ${migration.version} already registered`
      );
    }
    this.migrations.set(migration.version, migration);
  }

  /**
   * Register multiple migrations
   * @param migrations Array of migrations to register
   */
  registerAll(migrations: Migration[]): void {
    for (const migration of migrations) {
      this.register(migration);
    }
  }

  /**
   * Get a migration by version
   * @param version Migration version
   * @returns Migration or undefined if not found
   */
  get(version: number): Migration | undefined {
    return this.migrations.get(version);
  }

  /**
   * Get all registered migrations sorted by version
   * @returns Array of migrations
   */
  getAll(): Migration[] {
    return Array.from(this.migrations.values()).sort(
      (a, b) => a.version - b.version
    );
  }

  /**
   * Get migrations in a version range
   * @param fromVersion Starting version (inclusive)
   * @param toVersion Ending version (inclusive)
   * @returns Array of migrations in range
   */
  getRange(fromVersion: number, toVersion: number): Migration[] {
    return this.getAll().filter(
      (m) => m.version >= fromVersion && m.version <= toVersion
    );
  }

  /**
   * Get the highest migration version
   * @returns Highest version or 0 if no migrations
   */
  getHighestVersion(): number {
    const versions = Array.from(this.migrations.keys());
    return versions.length > 0 ? Math.max(...versions) : 0;
  }

  /**
   * Check if a migration version exists
   * @param version Migration version
   * @returns True if migration exists
   */
  has(version: number): boolean {
    return this.migrations.has(version);
  }

  /**
   * Get pending migrations (migrations not yet applied)
   * @param appliedVersions Set of already applied migration versions
   * @returns Array of pending migrations
   */
  getPending(appliedVersions: Set<number>): Migration[] {
    return this.getAll().filter((m) => !appliedVersions.has(m.version));
  }

  /**
   * Validate migration versions are sequential
   * @throws Error if versions are not sequential
   */
  validateSequential(): void {
    const versions = Array.from(this.migrations.keys()).sort((a, b) => a - b);
    for (let i = 0; i < versions.length; i++) {
      if (versions[i] !== i + 1) {
        throw new Error(
          `Migration versions must be sequential starting from 1. Found gap at version ${
            i + 1
          }`
        );
      }
    }
  }
}
