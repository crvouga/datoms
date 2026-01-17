/**
 * In-memory database implementation
 * Stores datoms in memory and executes queries in memory
 * Useful for testing and small datasets
 */

import { DatomDatabase } from "./datom-database.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";
import type {
  DatalogQuery,
  QueryClause,
  QueryResult,
} from "../datalog/datalog.js";
import { isVariable, stripQuestionMark } from "./shared/datalog-helpers.js";
import { joinResults, project } from "./shared/query-helpers.js";

/**
 * In-memory database implementation
 * Stores datoms in memory using an array-based structure
 */
export class InMemoryDatomDatabase extends DatomDatabase {
  private _datomsArray: Datom[] = [];
  private nextTx: TransactionId = 1;
  private queryCount: number = 0;
  private transactionCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionTimeSum: number = 0;

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this._datomsArray = [];
      this.nextTx = 1;
      this.initialized = true;
    }
  }

  async close(): Promise<void> {
    this._datomsArray = [];
    this.initialized = false;
  }

  protected async addDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = this.nextTx++;

    for (const datom of datoms) {
      this._datomsArray.push({
        e: datom.e,
        a: datom.a,
        v: datom.v,
        tx,
        op: "add",
      });
    }

    return tx;
  }

  protected async retractDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = this.nextTx++;

    for (const datom of datoms) {
      // Add retraction datom
      this._datomsArray.push({
        e: datom.e,
        a: datom.a,
        v: datom.v,
        tx,
        op: "retract",
      });
    }

    return tx;
  }

  /**
   * Check if a datom is currently add (not retract)
   */
  private isCurrentlyadd(datom: Datom): boolean {
    // Find the latest transaction for this (entity, attribute, value)
    let latest: Datom | null = null;
    for (const d of this._datomsArray) {
      if (d.e === datom.e && d.a === datom.a && d.v === datom.v) {
        if (!latest || d.tx > latest.tx) {
          latest = d;
        }
      }
    }
    return latest !== null && latest.op === "add";
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    return super.datoms(options);
  }

  public async getRawDatoms(options: QueryOptions): Promise<Datom[]> {
    // Get all datoms matching filters without deduplication
    let results = this._datomsArray;

    // Apply filters
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Don't filter by add - return all datoms including retract
    // The view will handle filtering and deduplication

    return results;
  }

  protected async executeQuery(options: QueryOptions): Promise<Datom[]> {
    let results = this._datomsArray;

    // Apply filters
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Handle retractions: for each unique (entity, attribute, value) combination,
    // keep only the most recent transaction
    // This ensures that retract datoms are not returned when querying
    // and supports multi-valued attributes (multiple values per attribute)
    // Always deduplicate first, then apply add filter

    // Normal query: deduplicate and filter
    // Deduplicate by (entity, attribute, value) to support multi-valued attributes
    const latestDatoms = new Map<string, Datom>();
    for (const datom of results) {
      // Use (entity, attribute, value) key for regular queries to support multi-valued attributes
      const key = `${String(datom.e)}|${String(
        datom.a
      )}|${JSON.stringify(datom.v)}`;
      const existing = latestDatoms.get(key);
      if (!existing || datom.tx > existing.tx) {
        latestDatoms.set(key, datom);
      }
    }
    results = Array.from(latestDatoms.values());

    // Apply op filter after deduplication
    // Default behavior: filter to only added datoms (exclude retracted)
    if (options.op === undefined || options.op === "add") {
      results = results.filter((d) => d.op === "add");
    } else if (options.op === "retract") {
      // If explicitly requesting retractions, filter by op: "retract"
      results = results.filter((d) => d.op === "retract");
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    const paginated = results.slice(offset, limit ? offset + limit : undefined);

    return paginated;
  }

  public async executeAsOfQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this.ensureInitialized();

    // Get all matching datoms without tx filter
    let results = this._datomsArray;

    // Apply filters (except tx, which we'll handle separately)
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }

    // Filter to only datoms with tx <= txId
    // If options.tx is specified, use the minimum of both
    const maxTx = options.tx !== undefined ? Math.min(options.tx, txId) : txId;
    results = results.filter((d) => d.tx <= maxTx);

    // Deduplicate by (entity, attribute) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const key = `${String(datom.e)}|${String(datom.a)}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out retract datoms (keep only op: "add")
    results = Array.from(deduplicated.values()).filter((d) => d.op === "add");

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  public async executeHistoryQuery(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();

    // Get all datoms matching filters without deduplication
    let results = this._datomsArray;

    // Apply filters
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Sort by tx ASC for history
    results.sort((a, b) => {
      if (a.tx !== b.tx) {
        return a.tx - b.tx;
      }
      // Secondary sort by entity, then attribute
      const entityA = String(a.e);
      const entityB = String(b.e);
      if (entityA !== entityB) {
        return entityA.localeCompare(entityB);
      }
      return String(a.a).localeCompare(String(b.a));
    });

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  public async executeSinceQuery(
    options: QueryOptions,
    txId: TransactionId
  ): Promise<Datom[]> {
    await this.ensureInitialized();

    // Get all matching datoms without tx filter
    let results = this._datomsArray;

    // Apply filters (except tx, which we'll handle separately)
    if (options.e !== undefined) {
      results = results.filter((d) => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter((d) => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter((d) => d.v === options.v);
    }

    // Filter to only datoms with tx > txId
    results = results.filter((d) => d.tx > txId);

    // Deduplicate by (entity, attribute, value) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const valueKey = JSON.stringify(datom.v);
      const key = `${String(datom.e)}|${String(datom.a)}|${valueKey}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out retract datoms (keep only op: "add")
    results = Array.from(deduplicated.values()).filter((d) => d.op === "add");

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  async query(query: DatalogQuery): Promise<QueryResult> {
    await this.ensureInitialized();
    // Simple implementation: for each where clause, query the database
    // and join the results
    if (query.where.length === 0) {
      return [];
    }

    // Start with the first clause
    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause);

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause);
      results = joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    // Project to find variables
    const projected = project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit
    if (query.limit) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  /**
   * Execute a single query clause
   */
  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value | Attribute>[]> {
    const { e: entityVal, a: attributeVal, v: valueVal } = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Datalog queries manage their own limiting via joins, so bypass validation
    const datoms = await this.queryInternal({
      e: entity,
      a: attribute,
      v: value,
    });

    // Map datom fields to variable names from the clause
    return datoms.map((datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom.e;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.a;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.v;
      }
      return result;
    });
  }

  /**
   * Get metadata associated with a transaction
   * Default implementation returns undefined (metadata storage not implemented)
   * Override onTransactionMetadata and this method to support metadata storage
   */
  async getTransactionMetadata(
    _txId: TransactionId
  ): Promise<Record<string, unknown> | undefined> {
    // Default: no metadata storage
    return undefined;
  }

  async getLatestTransaction(): Promise<TransactionId> {
    await this.ensureInitialized();
    // nextTx is the next transaction ID to be used, so latest is one less
    return this.nextTx > 1 ? this.nextTx - 1 : 0;
  }

  protected async recordQueryMetrics(duration: number): Promise<void> {
    this.queryCount++;
    this.queryTimeSum += duration;
  }

  protected async recordTransactionMetrics(duration: number): Promise<void> {
    this.transactionCount++;
    this.transactionTimeSum += duration;
  }

  protected async getDetailedStats(): Promise<
    Partial<
      Pick<
        import("../types.js").DatabaseStats,
        "totalDatoms" | "totalEntities" | "queryMetrics" | "transactionMetrics"
      >
    >
  > {
    const stats: Partial<import("../types.js").DatabaseStats> = {};

    // Count total datoms (only add ones)
    const addDatoms = this._datomsArray.filter((d) => {
      // Check if this is the latest version (not retract)
      const latestVersion = this._datomsArray
        .filter(
          (other) => other.e === d.e && other.a === d.a && other.v === d.v
        )
        .sort((a, b) => b.tx - a.tx)[0];
      return latestVersion?.op === "add" && latestVersion.tx === d.tx;
    });
    stats.totalDatoms = addDatoms.length;

    // Count unique entities
    const uniqueEntities = new Set(addDatoms.map((d) => String(d.e)));
    stats.totalEntities = uniqueEntities.size;

    // Add query metrics if available
    if (this.queryCount > 0) {
      stats.queryMetrics = {
        totalQueries: this.queryCount,
        averageQueryTime: this.queryTimeSum / this.queryCount / 1000, // Convert to seconds
      };
    }

    // Add transaction metrics if available
    if (this.transactionCount > 0) {
      stats.transactionMetrics = {
        averageTransactionTime:
          this.transactionTimeSum / this.transactionCount / 1000, // Convert to seconds
      };
    }

    return stats;
  }
}
