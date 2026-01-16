/**
 * In-memory database implementation
 * Stores datoms in memory and executes queries in memory
 * Useful for testing and small datasets
 */

import { DatomDatabase, type Transaction } from "./datom-database.js";
import type {
  Attribute,
  Datom,
  DatomInput,
  EntityId,
  QueryExplainResult,
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
import {
  getAllValuesBatchHelper,
  findEntitiesHelper,
  getLatestValueHelper,
  getValueHelper,
  getValuesBatchHelper,
  getValuesHelper,
  hasFactHelper,
  retractAttributeHelper,
  retractEntityHelper,
  transactHelper,
  upsertHelper,
} from "./shared/transaction-helpers.js";

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
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx,
        added: true,
      });
    }

    return tx;
  }

  protected async retractDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = this.nextTx++;

    for (const datom of datoms) {
      // Add retraction datom
      this._datomsArray.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx,
        added: false,
      });
    }

    return tx;
  }

  async retractEntity(entity: EntityId): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = this.nextTx++;

    // Get all datoms for this entity
    const entityDatoms = this._datomsArray.filter((d) => d.entity === entity);

    // Retract all of them
    for (const datom of entityDatoms) {
      // Only retract if it's currently added (not already retracted)
      const isCurrentlyAdded = this.isCurrentlyAdded(datom);
      if (isCurrentlyAdded) {
        this._datomsArray.push({
          entity: datom.entity,
          attribute: datom.attribute,
          value: datom.value,
          tx,
          added: false,
        });
      }
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
      if (
        d.entity === datom.entity &&
        d.attribute === datom.attribute &&
        d.value === datom.value
      ) {
        if (!latest || d.tx > latest.tx) {
          latest = d;
        }
      }
    }
    return latest !== null && latest.added;
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
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Don't filter by added - return all datoms including retracted
    // The view will handle filtering and deduplication

    return results;
  }

  protected async executeQuery(options: QueryOptions): Promise<Datom[]> {
    let results = this._datomsArray;

    // Apply filters
    if (options.entity !== undefined) {
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
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
      const key = `${String(datom.entity)}|${String(
        datom.attribute
      )}|${JSON.stringify(datom.value)}`;
      const existing = latestDatoms.get(key);
      if (!existing || datom.tx > existing.tx) {
        latestDatoms.set(key, datom);
      }
    }
    results = Array.from(latestDatoms.values());

    // Apply added filter after deduplication
    // Default behavior: filter to only added datoms (exclude retracted)
    if (options.added === undefined || options.added === true) {
      results = results.filter((d) => d.added === true);
    } else if (options.added === false) {
      // If explicitly requesting retractions, filter by added: false
      results = results.filter((d) => d.added === false);
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
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
    }

    // Filter to only datoms with tx <= txId
    // If options.tx is specified, use the minimum of both
    const maxTx =
      options.tx !== undefined ? Math.min(options.tx, txId) : txId;
    results = results.filter((d) => d.tx <= maxTx);

    // Deduplicate by (entity, attribute) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const key = `${String(datom.entity)}|${String(datom.attribute)}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out retracted datoms (keep only added: true)
    results = Array.from(deduplicated.values()).filter((d) => d.added);

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
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
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
      const entityA = String(a.entity);
      const entityB = String(b.entity);
      if (entityA !== entityB) {
        return entityA.localeCompare(entityB);
      }
      return String(a.attribute).localeCompare(String(b.attribute));
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
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
    }

    // Filter to only datoms with tx > txId
    results = results.filter((d) => d.tx > txId);

    // Deduplicate by (entity, attribute, value) keeping the latest tx
    const deduplicated = new Map<string, Datom>();
    for (const datom of results) {
      const valueKey = JSON.stringify(datom.value);
      const key = `${String(datom.entity)}|${String(datom.attribute)}|${valueKey}`;
      const existing = deduplicated.get(key);
      if (!existing || datom.tx > existing.tx) {
        deduplicated.set(key, datom);
      }
    }

    // Filter out retracted datoms (keep only added: true)
    results = Array.from(deduplicated.values()).filter((d) => d.added);

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  async explainQuery(options: QueryOptions): Promise<QueryExplainResult> {
    await this.ensureInitialized();
    const result = await super.explainQuery(options);

    // Estimate result size based on filters and current data
    let estimatedRows = this._datomsArray.length;

    // Apply filters to estimate result size
    if (options.entity !== undefined) {
      const entityCount = this._datomsArray.filter(
        (d) => d.entity === options.entity
      ).length;
      estimatedRows = Math.min(estimatedRows, entityCount);
    }
    if (options.attribute !== undefined) {
      const attributeCount = this._datomsArray.filter(
        (d) => d.attribute === options.attribute
      ).length;
      estimatedRows = Math.min(estimatedRows, attributeCount);
    }
    if (options.value !== undefined) {
      const valueCount = this._datomsArray.filter(
        (d) => d.value === options.value
      ).length;
      estimatedRows = Math.min(estimatedRows, valueCount);
    }
    if (options.tx !== undefined) {
      const txCount = this._datomsArray.filter(
        (d) => d.tx === options.tx
      ).length;
      estimatedRows = Math.min(estimatedRows, txCount);
    }

    // Apply limit if present
    if (options.limit !== undefined) {
      estimatedRows = Math.min(estimatedRows, options.limit);
    }

    // Normal queries deduplicate, so estimate is lower
    // Rough estimate: assume 50% reduction from deduplication
    result.estimatedRows = Math.floor(estimatedRows * 0.5);

    // Set scan type based on filters
    if (result.scanType === "full-table") {
      result.warnings = result.warnings || [];
      result.warnings.push(
        `In-memory database will scan all ${this._datomsArray.length} datoms. Consider adding filters.`
      );
    }

    return result;
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

  protected async executeTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    _isolationLevel?: import("../types.js").TransactionIsolationLevel
  ): Promise<T> {
    // Note: In-memory implementation doesn't enforce isolation levels
    // All transactions see uncommitted changes immediately
    await this.ensureInitialized();

    // Create snapshot of current state
    const snapshot = [...this._datomsArray];
    const snapshotNextTx = this.nextTx;

    const txId = this.nextTx++;
    const transaction = new InMemoryTransaction(this._datomsArray, txId, this);

    try {
      const result = await callback(transaction);
      // Transaction succeeded - changes are already applied to this.datoms
      return result;
    } catch (error) {
      // Rollback: restore snapshot
      this._datomsArray = snapshot;
      this.nextTx = snapshotNextTx;
      throw error;
    }
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
        result[entityVal as string] = datom.entity;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.attribute;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.value;
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
          (other) =>
            other.entity === d.entity &&
            other.attribute === d.attribute &&
            other.value === d.value
        )
        .sort((a, b) => b.tx - a.tx)[0];
      return latestVersion?.added === true && latestVersion.tx === d.tx;
    });
    stats.totalDatoms = addedDatoms.length;

    // Count unique entities
    const uniqueEntities = new Set(addedDatoms.map((d) => String(d.entity)));
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

/**
 * In-memory transaction implementation
 * Directly modifies the database's datoms array (changes are rolled back on error)
 */
class InMemoryTransaction implements Transaction {
  private _datomsArray: Datom[];
  private txId: TransactionId;
  private db: InMemoryDatomDatabase;

  constructor(datoms: Datom[], txId: TransactionId, db: InMemoryDatomDatabase) {
    this._datomsArray = datoms;
    this.txId = txId;
    this.db = db;
  }

  getTransactionId(): TransactionId {
    return this.txId;
  }

  async datoms(options: QueryOptions): Promise<Datom[]> {
    // Query directly from the datoms array (which includes uncommitted changes)
    let results = this._datomsArray;

    // Apply filters
    if (options.entity !== undefined) {
      results = results.filter((d) => d.entity === options.entity);
    }
    if (options.attribute !== undefined) {
      results = results.filter((d) => d.attribute === options.attribute);
    }
    if (options.value !== undefined) {
      results = results.filter((d) => d.value === options.value);
    }
    if (options.tx !== undefined) {
      results = results.filter((d) => d.tx === options.tx);
    }

    // Normal query: deduplicate and filter
    // Handle retractions: for each unique (entity, attribute, value) combination,
    // keep only the most recent transaction
    // This supports multi-valued attributes (multiple values per attribute)
    // Always deduplicate first, then apply added filter
    const latestDatoms = new Map<string, Datom>();
    for (const datom of results) {
      const key = `${String(datom.entity)}|${String(
        datom.attribute
      )}|${String(datom.value)}`;
      const existing = latestDatoms.get(key);
      if (!existing || datom.tx > existing.tx) {
        latestDatoms.set(key, datom);
      }
    }
    results = Array.from(latestDatoms.values());

    // Apply added filter after deduplication
    if (options.added === undefined || options.added === true) {
      // Filter to only added datoms (exclude retractions)
      results = results.filter((d) => d.added);
    } else if (options.added === false) {
      // For retractions, filter by added: false
      results = results.filter((d) => !d.added);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    const paginated = results.slice(offset, limit ? offset + limit : undefined);

    return paginated;
  }

  async explainQuery(options: QueryOptions): Promise<QueryExplainResult> {
    // Delegate to database's explainQuery
    return this.db.explainQuery(options);
  }

  async getValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined> {
    return getValueHelper(this.datoms.bind(this), entity, attribute);
  }

  async getLatestValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined> {
    return getLatestValueHelper(this.datoms.bind(this), entity, attribute);
  }

  async getValues(entity: EntityId, attribute: string): Promise<Value[]> {
    return getValuesHelper(this.datoms.bind(this), entity, attribute);
  }

  async hasFact(
    entity: EntityId,
    attribute: string,
    value: Value
  ): Promise<boolean> {
    return hasFactHelper(this.datoms.bind(this), entity, attribute, value);
  }

  async getValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<(Value | undefined)[]> {
    return getValuesBatchHelper(this.datoms.bind(this), queries);
  }

  async getAllValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<Value[][]> {
    return getAllValuesBatchHelper(this.datoms.bind(this), queries);
  }

  async findEntities(attribute: string, value: Value): Promise<EntityId[]> {
    return findEntitiesHelper(this.datoms.bind(this), attribute, value);
  }

  async add(datoms: DatomInput[]): Promise<void> {
    for (const datom of datoms) {
      this._datomsArray.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx: this.txId,
        added: true,
      });
    }
  }

  async retract(datoms: DatomInput[]): Promise<void> {
    for (const datom of datoms) {
      // Remove any pending adds for this exact datom (same entity, attribute, value)
      // that were added in this transaction
      const key = `${String(datom[0])}|${String(datom[1])}|${String(datom[2])}`;

      // Find and remove matching pending adds (modify array in place)
      for (let i = this._datomsArray.length - 1; i >= 0; i--) {
        const d = this._datomsArray[i];
        if (d.tx === this.txId && d.added) {
          const dKey = `${String(d.entity)}|${String(d.attribute)}|${String(
            d.value
          )}`;
          if (dKey === key) {
            this._datomsArray.splice(i, 1);
          }
        }
      }

      // Add retraction datom
      this._datomsArray.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx: this.txId,
        added: false,
      });
    }
  }

  async retractEntity(entity: EntityId): Promise<void> {
    return retractEntityHelper(
      this.datoms.bind(this),
      this.retract.bind(this),
      entity
    );
  }

  async retractAttribute(entity: EntityId, attribute: string): Promise<void> {
    return retractAttributeHelper(
      this.datoms.bind(this),
      this.retract.bind(this),
      entity,
      attribute
    );
  }

  async upsert(
    entity: EntityId,
    attribute: string,
    value: Value
  ): Promise<void> {
    return upsertHelper(
      this.datoms.bind(this),
      (attr: string) => this.db.getAttributeDefinition(attr),
      this.retract.bind(this),
      this.add.bind(this),
      entity,
      attribute,
      value
    );
  }

  async transact(ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }): Promise<void> {
    return transactHelper(this.add.bind(this), this.retract.bind(this), ops);
  }

  async query(query: DatalogQuery): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause);

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

    const projected = project(results, query.find, query.where);

    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const key = stripQuestionMark(variable);
          const aVal = a[key];
          const bVal = b[key];

          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (aVal < bVal) return direction === "asc" ? -1 : 1;
          if (aVal > bVal) return direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    if (query.limit) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value | Attribute>[]> {
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Use transaction's query method to see uncommitted changes
    const queryOptions: QueryOptions = {
      ...(entity !== undefined && { entity }),
      ...(attribute !== undefined && { attribute }),
      ...(value !== undefined && { value }),
    };

    const datoms = await this.datoms(queryOptions);

    return datoms.map((datom: Datom) => {
      const result: Record<string, Value | Attribute> = {};
      if (isVariable(entityVal)) {
        result[entityVal as string] = datom.entity;
      }
      if (isVariable(attributeVal)) {
        result[attributeVal as string] = datom.attribute;
      }
      if (isVariable(valueVal)) {
        result[valueVal as string] = datom.value;
      }
      return result;
    });
  }
}
