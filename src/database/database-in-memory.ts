/**
 * In-memory database implementation
 * Stores datoms in memory and executes queries in memory
 * Useful for testing and small datasets
 */

import { Database, type Transaction } from "./database.js";
import type {
  Datom,
  DatomInput,
  EntityId,
  QueryOptions,
  TransactionId,
  Value,
} from "../types.js";
import type { DatalogQuery, QueryClause, QueryResult } from "./datalog.js";

/**
 * In-memory database implementation
 * Stores datoms in memory using an array-based structure
 */
export class InMemoryDatabase extends Database {
  private datoms: Datom[] = [];
  private nextTx: TransactionId = 1;

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.datoms = [];
      this.nextTx = 1;
      this.initialized = true;
    }
  }

  async close(): Promise<void> {
    this.datoms = [];
    this.initialized = false;
  }

  async add(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = this.nextTx++;

    for (const datom of datoms) {
      this.datoms.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx,
        added: true,
      });
    }

    return tx;
  }

  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = this.nextTx++;

    for (const datom of datoms) {
      // Add retraction datom
      this.datoms.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx,
        added: false,
      });
    }

    return tx;
  }

  async query(options: QueryOptions = {}): Promise<Datom[]> {
    await this.ensureInitialized();
    let results = this.datoms;

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
    if (options.added === undefined || options.added === true) {
      // Group by (entity, attribute, value) and keep only the most recent transaction
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

      // Filter to only added datoms (default behavior)
      results = results.filter((d) => d.added);
    } else if (options.added === false) {
      // If explicitly requesting retractions, filter by added: false
      results = results.filter((d) => !d.added);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    const paginated = results.slice(offset, limit ? offset + limit : undefined);

    return paginated;
  }

  async queryDatalog(query: DatalogQuery): Promise<QueryResult> {
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
      results = this.joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    // Project to find variables
    const projected = this.project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const aVal = a[variable];
          const bVal = b[variable];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          // Handle symbol comparison
          if (typeof aVal === "symbol" || typeof bVal === "symbol") {
            const aStr = String(aVal);
            const bStr = String(bVal);
            if (aStr < bStr) return direction === "asc" ? -1 : 1;
            if (aStr > bStr) return direction === "asc" ? 1 : -1;
          } else {
            if (aVal < bVal) return direction === "asc" ? -1 : 1;
            if (aVal > bVal) return direction === "asc" ? 1 : -1;
          }
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

  async getEntity(entity: EntityId): Promise<Datom[]> {
    await this.ensureInitialized();
    return this.query({ entity, added: true });
  }

  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ensureInitialized();

    // Create snapshot of current state
    const snapshot = [...this.datoms];
    const snapshotNextTx = this.nextTx;

    const txId = this.nextTx++;
    const transaction = new InMemoryTransaction(this.datoms, txId, this);

    try {
      const result = await callback(transaction);
      // Transaction succeeded - changes are already applied to this.datoms
      return result;
    } catch (error) {
      // Rollback: restore snapshot
      this.datoms = snapshot;
      this.nextTx = snapshotNextTx;
      throw error;
    }
  }

  /**
   * Execute a single query clause
   */
  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value>[]> {
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = this.isVariable(entityVal)
      ? undefined
      : (entityVal as EntityId);
    const attribute = this.isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = this.isVariable(valueVal) ? undefined : (valueVal as Value);

    const datoms = await this.query({
      entity,
      attribute,
      value,
    });

    // Map datom fields to variable names from the clause
    return datoms.map((datom) => {
      const result: Record<string, Value> = {};
      if (this.isVariable(entityVal)) {
        result[entityVal as string] = datom.entity;
      }
      if (this.isVariable(attributeVal)) {
        result[attributeVal as string] = datom.attribute;
      }
      if (this.isVariable(valueVal)) {
        result[valueVal as string] = datom.value;
      }
      return result;
    });
  }

  /**
   * Join two result sets based on common variables
   */
  private joinResults(
    left: Record<string, Value>[],
    right: Record<string, Value>[],
    clauses: QueryClause[]
  ): Record<string, Value>[] {
    const joined: Record<string, Value>[] = [];

    for (const leftRow of left) {
      for (const rightRow of right) {
        // Check if rows are compatible (same values for common variables)
        let compatible = true;
        for (const key of Object.keys(leftRow)) {
          if (key in rightRow && leftRow[key] !== rightRow[key]) {
            compatible = false;
            break;
          }
        }

        if (compatible) {
          joined.push({ ...leftRow, ...rightRow });
        }
      }
    }

    return joined;
  }

  /**
   * Project results to only include find variables
   */
  private project(
    results: Record<string, Value>[],
    find: string[],
    clauses: QueryClause[]
  ): QueryResult {
    if (find.length === 0) {
      return results;
    }

    // Results already have variable names as keys, so just extract the find variables
    return results.map((row) => {
      const projected: Record<string, Value> = {};
      for (const varName of find) {
        if (varName in row) {
          projected[varName] = row[varName];
        }
      }
      return projected;
    });
  }

  /**
   * Check if a value is a variable (starts with ?)
   */
  private isVariable(value: any): boolean {
    return typeof value === "string" && value.startsWith("?");
  }
}

/**
 * In-memory transaction implementation
 * Directly modifies the database's datoms array (changes are rolled back on error)
 */
class InMemoryTransaction implements Transaction {
  private datoms: Datom[];
  private txId: TransactionId;
  private db: InMemoryDatabase;

  constructor(datoms: Datom[], txId: TransactionId, db: InMemoryDatabase) {
    this.datoms = datoms;
    this.txId = txId;
    this.db = db;
  }

  async query(options: QueryOptions = {}): Promise<Datom[]> {
    // Query directly from the datoms array (which includes uncommitted changes)
    let results = this.datoms;

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
    // If the latest is a retraction (added: false), exclude it from results
    if (options.added === undefined || options.added === true) {
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
      // Filter to only added datoms (exclude retractions)
      results = results.filter((d) => d.added);
    } else if (options.added === false) {
      // For retractions, also need to get latest per key
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
      results = results.filter((d) => !d.added);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    const paginated = results.slice(offset, limit ? offset + limit : undefined);

    return paginated;
  }

  async add(datoms: DatomInput[]): Promise<TransactionId> {
    for (const datom of datoms) {
      this.datoms.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx: this.txId,
        added: true,
      });
    }
    return this.txId;
  }

  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    for (const datom of datoms) {
      // Remove any pending adds for this exact datom (same entity, attribute, value)
      // that were added in this transaction
      const key = `${String(datom[0])}|${String(datom[1])}|${String(datom[2])}`;

      // Find and remove matching pending adds (modify array in place)
      for (let i = this.datoms.length - 1; i >= 0; i--) {
        const d = this.datoms[i];
        if (d.tx === this.txId && d.added) {
          const dKey = `${String(d.entity)}|${String(d.attribute)}|${String(
            d.value
          )}`;
          if (dKey === key) {
            this.datoms.splice(i, 1);
          }
        }
      }

      // Add retraction datom
      this.datoms.push({
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx: this.txId,
        added: false,
      });
    }
    return this.txId;
  }

  async queryDatalog(query: DatalogQuery): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause);

    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause);
      results = this.joinResults(
        results,
        clauseResults,
        query.where.slice(0, i + 1)
      );
    }

    const projected = this.project(results, query.find, query.where);

    if (query.orderBy) {
      projected.sort((a, b) => {
        for (const [variable, direction] of query.orderBy!) {
          const aVal = a[variable];
          const bVal = b[variable];

          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === "asc" ? -1 : 1;
          if (bVal == null) return direction === "asc" ? 1 : -1;

          if (typeof aVal === "symbol" || typeof bVal === "symbol") {
            const aStr = String(aVal);
            const bStr = String(bVal);
            if (aStr < bStr) return direction === "asc" ? -1 : 1;
            if (aStr > bStr) return direction === "asc" ? 1 : -1;
          } else {
            if (aVal < bVal) return direction === "asc" ? -1 : 1;
            if (aVal > bVal) return direction === "asc" ? 1 : -1;
          }
        }
        return 0;
      });
    }

    if (query.limit) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  async getEntity(entity: EntityId): Promise<Datom[]> {
    return this.query({ entity, added: true });
  }

  async getValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined> {
    const datoms = await this.query({ entity, attribute });
    return datoms.length > 0 ? datoms[0].value : undefined;
  }

  async getValues(entity: EntityId, attribute: string): Promise<Value[]> {
    const datoms = await this.query({ entity, attribute });
    return datoms.map((d) => d.value);
  }

  async hasFact(
    entity: EntityId,
    attribute: string,
    value: Value
  ): Promise<boolean> {
    const datoms = await this.query({ entity, attribute, value });
    return datoms.length > 0;
  }

  private async executeClause(
    clause: QueryClause
  ): Promise<Record<string, Value>[]> {
    const [entityVal, attributeVal, valueVal] = clause;
    const entity = this.isVariable(entityVal)
      ? undefined
      : (entityVal as EntityId);
    const attribute = this.isVariable(attributeVal)
      ? undefined
      : (attributeVal as string);
    const value = this.isVariable(valueVal) ? undefined : (valueVal as Value);

    const datoms = await this.query({
      entity,
      attribute,
      value,
    });

    return datoms.map((datom) => {
      const result: Record<string, Value> = {};
      if (this.isVariable(entityVal)) {
        result[entityVal as string] = datom.entity;
      }
      if (this.isVariable(attributeVal)) {
        result[attributeVal as string] = datom.attribute;
      }
      if (this.isVariable(valueVal)) {
        result[valueVal as string] = datom.value;
      }
      return result;
    });
  }

  private joinResults(
    left: Record<string, Value>[],
    right: Record<string, Value>[],
    clauses: QueryClause[]
  ): Record<string, Value>[] {
    const joined: Record<string, Value>[] = [];

    for (const leftRow of left) {
      for (const rightRow of right) {
        let compatible = true;
        for (const key of Object.keys(leftRow)) {
          if (key in rightRow && leftRow[key] !== rightRow[key]) {
            compatible = false;
            break;
          }
        }

        if (compatible) {
          joined.push({ ...leftRow, ...rightRow });
        }
      }
    }

    return joined;
  }

  private project(
    results: Record<string, Value>[],
    find: string[],
    clauses: QueryClause[]
  ): QueryResult {
    if (find.length === 0) {
      return results;
    }

    return results.map((row) => {
      const projected: Record<string, Value> = {};
      for (const varName of find) {
        if (varName in row) {
          projected[varName] = row[varName];
        }
      }
      return projected;
    });
  }

  private isVariable(value: any): boolean {
    return typeof value === "string" && value.startsWith("?");
  }
}
