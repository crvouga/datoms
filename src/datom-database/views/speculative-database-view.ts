/**
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
 */

import type { Datom, QueryOptions } from "../../types.js";
import { executeQueryOnDatoms } from "../shared/in-memory-query-executor.js";
import { BaseDatabaseView } from "./base-database-view.js";
import { InternalDatabaseView } from "./internal-database-view.js";

/**
 * Database view showing speculative state with pending changes applied
 * Merges base database state with speculative adds and subs
 * Used by the `with()` method for speculative transactions
 */
export class SpeculativeDatabaseView extends BaseDatabaseView {
  private mergedDatoms: Datom[] | null = null;

  constructor(
    db: InternalDatabaseView,
    private speculativeAdds: Datom[],
    private speculativeSubs: Datom[]
  ) {
    super(db);
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Validate that query has at least one filter or limit to prevent accidental full scans
    this.validateQueryOptions(options);

    // Lazy initialization: merge base datoms with speculative changes only once
    if (!this.mergedDatoms) {
      // Get all base datoms using executeHistoryQuery to bypass validation
      // This returns all datoms including retracted ones, so we need to deduplicate
      const allBaseDatoms = await this.db.executeHistoryQuery({});

      // Create a map of base datoms by (entity, attribute, value) for efficient lookup
      // Deduplicate by keeping the latest transaction for each (entity, attribute, value)
      const baseMap = new Map<string, Datom>();
      for (const datom of allBaseDatoms) {
        const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
        const existing = baseMap.get(key);
        if (!existing || datom.tx > existing.tx) {
          baseMap.set(key, datom);
        }
      }

      // Filter to only asserted datoms (current state)
      const currentStateDatoms = Array.from(baseMap.values()).filter(
        (d) => d.op === "assert"
      );

      // Create a map for merging with speculative changes
      const mergedMap = new Map<string, Datom>();
      for (const datom of currentStateDatoms) {
        const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
        mergedMap.set(key, datom);
      }

      // Apply subs first (remove matching datoms)
      for (const sub of this.speculativeSubs) {
        const key = `${String(sub.e)}|${String(sub.a)}|${JSON.stringify(sub.v)}`;
        mergedMap.delete(key);
      }

      // Apply adds (add or update datoms)
      for (const add of this.speculativeAdds) {
        const key = `${String(add.e)}|${String(add.a)}|${JSON.stringify(add.v)}`;
        mergedMap.set(key, add);
      }

      // Create merged datoms array
      this.mergedDatoms = Array.from(mergedMap.values());
    }

    // Use the shared query execution logic
    return executeQueryOnDatoms(this.mergedDatoms, options);
  }
}
