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
      this._datomsArray.push([datom[0], datom[1], datom[2], tx, true] as Datom);
    }

    return tx;
  }

  protected async retractDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = this.nextTx++;

    for (const datom of datoms) {
      // Add retraction datom
      this._datomsArray.push([
        datom[0],
        datom[1],
        datom[2],
        tx,
        false,
      ] as Datom);
    }

    return tx;
  }

  /**
   * Check if a datom is currently added (not retracted)
   */
  private isCurrentlyAdded(datom: Datom): boolean {
    // Find the latest transaction for this (entity, attribute, value)
    let latest: Datom | null = null;
    for (const d of this._datomsArray) {
      if (d[0] === datom[0] && d[1] === datom[1] && d[2] === datom[2]) {
        if (!latest || d[3] > latest[3]) {
          latest = d;
        }
      }
    }
    return latest !== null && latest[4];
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    await this.ensureInitialized();
    return super.datoms(options);
  }

  public async getRawDatoms(options: QueryOptions): Promise<Datom[]> {
    // Get all datoms matching filters without deduplication
    let results = this._datomsArray;

    // Apply filters
    if (options.entity !== undefined) {
      results = results.filter((d) => d[0] === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d[1] === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d[2] === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d[3] === options.tx);
    }

    // Don't filter by added - return all datoms including retracted
    // The view will handle filtering and deduplication

    return results;
  }

  protected async executeQuery(options: QueryOptions): Promise<Datom[]> {
    let results = this._datomsArray;

    // Apply filters
    if (options.entity !== undefined) {
      results = results.filter((d) => d[0] === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d[1] === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d[2] === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d[3] === options.tx);
    }

    // Handle retractions: for each unique (entity, attribute, value) combination,
    // keep only the most recent transaction
    // This ensures that retracted datoms are not returned when querying
    // and supports multi-valued attributes (multiple values per attribute)
    // Always deduplicate first, then apply added filter

    // Normal query: deduplicate and filter
    // Deduplicate by (entity, attribute, value) to support multi-valued attributes
    const latestDatoms = new Map<string, Datom>();
    for (const datom of results) {
      // Use (entity, attribute, value) key for regular queries to support multi-valued attributes
      const key = `${String(datom[0])}|${String(
        datom[1]
      )}|${JSON.stringify(datom[2])}`;
      const existing = latestDatoms.get(key);
      if (!existing || datom[3] > existing[3]) {
        latestDatoms.set(key, datom);
      }
    }
    results = Array.from(latestDatoms.values());

    // Apply added filter after deduplication
    // Default behavior: filter to only added datoms (exclude retracted)
    if (options.added === undefined || options.added === true) {
      results = results.filter((d) => d[4] === true);
    } else if (options.added === false) {
      // If explicitly requesting retractions, filter by added: false
      results = results.filter((d) => d[4] === false);
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
    if (options.entity !== undefined) {
      results = results.filter((d) => d[0] === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d[1] === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d[2] === options.value);
    }

    // Filter to only datoms with tx <= txId
    // If options.tx is specified, use the minimum of both
    const maxTx = options.tx !== undefined ? Math.min(options.tx, txId) : txId;
    results = results.filter((d) => d[3] <= maxTx);

    // Deduplicate by (entity, attribute) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const key = `${String(datom[0])}|${String(datom[1])}`;
      const existing = deduplicated.get(key);
      if (!existing || datom[3] > existing[3]) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out retracted datoms (keep only added: true)
    results = Array.from(deduplicated.values()).filter((d) => d[4]);

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
    if (options.entity !== undefined) {
      results = results.filter((d) => d[0] === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d[1] === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d[2] === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d[3] === options.tx);
    }

    // Sort by tx ASC for history
    results.sort((a, b) => {
      if (a[3] !== b[3]) {
        return a[3] - b[3];
      }
      // Secondary sort by entity, then attribute
      const entityA = String(a[0]);
      const entityB = String(b[0]);
      if (entityA !== entityB) {
        return entityA.localeCompare(entityB);
      }
      return String(a[1]).localeCompare(String(b[1]));
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
    if (options.entity !== undefined) {
      results = results.filter((d) => d[0] === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d[1] === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d[2] === options.value);
    }

    // Filter to only datoms with tx > txId
    results = results.filter((d) => d[3] > txId);

    // Deduplicate by (entity, attribute, value) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const valueKey = JSON.stringify(datom[2]);
      const key = `${String(datom[0])}|${String(datom[1])}|${valueKey}`;
      const existing = deduplicated.get(key);
      if (!existing || datom[3] > existing[3]) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out retracted datoms (keep only added: true)
    results = Array.from(deduplicated.values()).filter((d) => d[4]);

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
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Datalog queries manage their own limiting via joins, so bypass validation
    const datoms = await this.queryInternal({
      entity,
      attribute,
      value,
    });

    // Map datom fields to variable names from the clause
    return datoms.map((datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom[0];
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom[1];
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom[2];
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

    // Count total datoms (only added ones)
    const addedDatoms = this._datomsArray.filter((d) => {
      // Check if this is the latest version (not retracted)
      const latestVersion = this._datomsArray
        .filter(
          (other) => other[0] === d[0] && other[1] === d[1] && other[2] === d[2]
        )
        .sort((a, b) => b[3] - a[3])[0];
      return latestVersion?.[4] === true && latestVersion[3] === d[3];
    });
    stats.totalDatoms = addedDatoms.length;

    // Count unique entities
    const uniqueEntities = new Set(addedDatoms.map((d) => String(d[0])));
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
