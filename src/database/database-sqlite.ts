/**
 * SQLite database implementation
 * Accepts a SqlConnection interface for SQLite-compatible databases
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
import type { SqlConnection } from "./sql-connection-adapter.js";

/**
 * SQLite database implementation
 * Accepts a SqlConnection that implements SQLite-compatible SQL
 */
export class SQLiteDatabase extends Database {
  private connection: SqlConnection;
  private tableName: string;
  protected initialized = false;

  constructor(connection: SqlConnection, tableName: string = "datoms") {
    super();
    this.connection = connection;
    this.tableName = tableName;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          entity TEXT NOT NULL,
          attribute TEXT NOT NULL,
          value TEXT NOT NULL,
          tx INTEGER NOT NULL,
          added INTEGER NOT NULL,
          PRIMARY KEY (entity, attribute, value, tx, added)
        )
      `;

      const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_entity ON ${this.tableName}(entity)`,
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_attribute ON ${this.tableName}(attribute)`,
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx)`,
      ];

      await this.connection.execute(createTableSql);
      for (const indexSql of indexes) {
        await this.connection.execute(indexSql);
      }

      // Create transaction counter table
      const txTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName}_tx (
          id INTEGER PRIMARY KEY,
          last_tx INTEGER NOT NULL DEFAULT 0
        )
      `;
      await this.connection.execute(txTableSql);

      // Initialize transaction counter if needed
      const initTxSql = `
        INSERT INTO ${this.tableName}_tx (id, last_tx)
        SELECT 1, 0
        WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
      `;
      await this.connection.execute(initTxSql);

      this.initialized = true;
    }
  }

  async close(): Promise<void> {
    if (this.connection.close) {
      await this.connection.close();
    }
    this.initialized = false;
  }

  async add(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = await this.getNextTransactionId();
    await this.addDatoms(datoms, tx);
    return tx;
  }

  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = await this.getNextTransactionId();
    await this.retractDatoms(datoms, tx);
    return tx;
  }

  async query(options: QueryOptions = {}): Promise<Datom[]> {
    await this.ensureInitialized();
    const conditions: string[] = [];
    const params: any[] = [];

    // Apply time-travel filter: if asOf is specified, only consider datoms up to that transaction
    if (options.asOf !== undefined) {
      conditions.push("tx <= ?");
      params.push(options.asOf);
    }

    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      params.push(String(options.entity));
    }
    if (options.attribute !== undefined) {
      conditions.push("attribute = ?");
      params.push(String(options.attribute));
    }
    if (options.value !== undefined) {
      conditions.push("value = ?");
      let value = options.value;
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      if (typeof value === "symbol") {
        value = `__SYMBOL__${String(value)}`;
      }
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Check if this is a history query (added === undefined with no filters means history)
    // History queries return all datoms ordered by transaction (no deduplication, include retracted)
    const isHistoryQuery =
      options.added === undefined &&
      options.asOf === undefined &&
      options.entity === undefined &&
      options.attribute === undefined &&
      options.value === undefined &&
      options.tx === undefined;

    // For history queries, return all datoms ordered by tx
    if (isHistoryQuery) {
      const sql = `
        SELECT entity, attribute, value, tx, added
        FROM ${this.tableName}
        ${whereClause}
        ORDER BY tx ASC, entity ASC, attribute ASC
      `;

      const rows = await this.connection.query(sql, params);
      const offset = options.offset ?? 0;
      const paginated = options.limit
        ? rows.slice(offset, offset + options.limit)
        : rows.slice(offset);

      const reviveValue = (value: any): any => {
        if (typeof value === "string") {
          if (value === "__UNDEFINED__") {
            return undefined;
          }
          if (value.startsWith("__SYMBOL__")) {
            const symbolDesc = value.substring("__SYMBOL__".length);
            return Symbol(symbolDesc);
          }
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
            return new Date(value);
          }
        }
        if (value === null) {
          return null;
        }
        if (value === undefined) {
          return undefined;
        }
        if (Array.isArray(value)) {
          return value.map(reviveValue);
        }
        if (typeof value === "object") {
          const revived: any = {};
          for (const key in value) {
            revived[key] = reviveValue(value[key]);
          }
          return revived;
        }
        return value;
      };

      return paginated.map((row: any) => {
        let entity: any = row.entity;
        if (typeof entity === "string") {
          if (/^-?\d+$/.test(entity)) {
            entity = parseInt(entity, 10);
          }
        }

        const parsedValue = JSON.parse(row.value);
        const revivedValue = reviveValue(parsedValue);

        return {
          entity,
          attribute: row.attribute,
          value: revivedValue,
          tx: row.tx,
          added: row.added,
        };
      });
    }

    const sql = `
      SELECT entity, attribute, value, tx, added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx DESC
    `;

    const rows = await this.connection.query(sql, params);

    // Group by (entity, attribute, value) or (entity, attribute) depending on query type
    // For time-travel queries (asOf), deduplicate by (entity, attribute) to get latest value per attribute
    // For regular queries, deduplicate by (entity, attribute, value) to support multi-valued attributes
    // Note: row.value is already a JSON string from the database, use it directly
    const latestDatoms = new Map<string, any>();
    for (const row of rows) {
      // Use (entity, attribute) key for time-travel queries to get latest value per attribute
      // Use (entity, attribute, value) key for regular queries to support multi-valued attributes
      const key =
        options.asOf !== undefined
          ? `${row.entity}|${row.attribute}`
          : `${row.entity}|${row.attribute}|${row.value}`;
      const existing = latestDatoms.get(key);
      if (!existing || row.tx > existing.tx) {
        latestDatoms.set(key, row);
      }
    }

    let results = Array.from(latestDatoms.values());

    // Convert added from integer (0/1) to boolean for consistent filtering
    // SQLite stores added as INTEGER, so we need to convert it
    results = results.map((r) => ({
      ...r,
      added: Boolean(r.added),
    }));

    if (options.added === undefined || options.added === true) {
      results = results.filter((r) => r.added === true);
    } else if (options.added === false) {
      results = results.filter((r) => r.added === false);
    }

    // Sort by entity, then attribute for consistent ordering
    results.sort((a, b) => {
      // Convert entity to number for comparison
      let entityA: number;
      if (typeof a.entity === "number") {
        entityA = a.entity;
      } else {
        const entityStr = String(a.entity);
        entityA = /^-?\d+$/.test(entityStr) ? parseInt(entityStr, 10) : 0;
      }

      let entityB: number;
      if (typeof b.entity === "number") {
        entityB = b.entity;
      } else {
        const entityStr = String(b.entity);
        entityB = /^-?\d+$/.test(entityStr) ? parseInt(entityStr, 10) : 0;
      }

      if (entityA !== entityB) {
        return entityA - entityB;
      }
      return String(a.attribute).localeCompare(String(b.attribute));
    });

    const offset = options.offset ?? 0;
    const paginated = options.limit
      ? results.slice(offset, offset + options.limit)
      : results.slice(offset);

    const reviveValue = (value: any): any => {
      if (typeof value === "string") {
        if (value === "__UNDEFINED__") {
          return undefined;
        }
        if (value.startsWith("__SYMBOL__")) {
          const symbolDesc = value.substring("__SYMBOL__".length);
          return Symbol(symbolDesc);
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          return new Date(value);
        }
      }
      if (value === null) {
        return null;
      }
      if (value === undefined) {
        return undefined;
      }
      if (Array.isArray(value)) {
        return value.map(reviveValue);
      }
      if (typeof value === "object") {
        const revived: any = {};
        for (const key in value) {
          revived[key] = reviveValue(value[key]);
        }
        return revived;
      }
      return value;
    };

    return paginated.map((row: any) => {
      let entity: any = row.entity;
      if (typeof entity === "string") {
        if (/^-?\d+$/.test(entity)) {
          entity = parseInt(entity, 10);
        }
      }

      const parsedValue = JSON.parse(row.value);
      const revivedValue = reviveValue(parsedValue);

      return {
        entity,
        attribute: row.attribute,
        value: revivedValue,
        tx: row.tx,
        added: Boolean(row.added), // Ensure boolean conversion
      };
    });
  }

  async queryDatalog(query: DatalogQuery): Promise<QueryResult> {
    await this.ensureInitialized();
    if (query.where.length === 0) {
      return [];
    }

    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause, query.asOf);

    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause, query.asOf);
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
    await this.ensureInitialized();
    return this.query({ entity, added: true });
  }

  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.ensureInitialized();

    if (
      !this.connection.beginTransaction ||
      !this.connection.commitTransaction ||
      !this.connection.rollbackTransaction
    ) {
      throw new Error(
        "Transaction support requires beginTransaction, commitTransaction, and rollbackTransaction methods"
      );
    }

    const txId = await this.getNextTransactionId();
    const transaction = this.createTransaction(txId);

    await this.connection.beginTransaction();
    try {
      const result = await callback(transaction);
      // Apply pending changes before committing
      await (transaction as any).commit();
      await this.connection.commitTransaction();
      return result;
    } catch (error) {
      await this.connection.rollbackTransaction();
      throw error;
    }
  }

  /**
   * SQLite transaction implementation
   * Tracks pending changes and merges them with queries
   */
  private createTransaction(txId: TransactionId): Transaction {
    return new SQLiteTransaction(this.connection, this.tableName, txId, this);
  }

  private async getNextTransactionId(): Promise<TransactionId> {
    const initTxSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      SELECT 1, 0
      WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
    `;
    await this.connection.execute(initTxSql);

    const updateSql = `
      UPDATE ${this.tableName}_tx
      SET last_tx = last_tx + 1
      WHERE id = 1
    `;
    await this.connection.execute(updateSql);

    const selectSql = `
      SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1
    `;
    const result = await this.connection.query(selectSql);
    if (!result || result.length === 0) {
      throw new Error("Transaction counter row not found after update");
    }
    return result[0].last_tx;
  }

  private async addDatoms(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `;

    const params = datoms.flatMap((d) => {
      let value = d[2];
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      if (typeof value === "symbol") {
        value = `__SYMBOL__${String(value)}`;
      }
      return [String(d[0]), String(d[1]), JSON.stringify(value), tx, true];
    });

    await this.connection.execute(sql, params);
  }

  private async retractDatoms(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ON CONFLICT DO NOTHING
    `;

    const params = datoms.flatMap((d) => {
      let value = d[2];
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      if (typeof value === "symbol") {
        value = `__SYMBOL__${String(value)}`;
      }
      return [String(d[0]), String(d[1]), JSON.stringify(value), tx, false];
    });

    await this.connection.execute(sql, params);
  }

  private async executeClause(
    clause: QueryClause,
    asOf?: TransactionId
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
      asOf,
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

/**
 * SQLite transaction implementation
 * Tracks pending changes and merges them with queries
 */
class SQLiteTransaction implements Transaction {
  private connection: SqlConnection;
  private tableName: string;
  private txId: TransactionId;
  private db: SQLiteDatabase;
  private pendingAdds: Datom[] = [];
  private pendingRetracts: Datom[] = [];

  constructor(
    connection: SqlConnection,
    tableName: string,
    txId: TransactionId,
    db: SQLiteDatabase
  ) {
    this.connection = connection;
    this.tableName = tableName;
    this.txId = txId;
    this.db = db;
  }

  async query(options: QueryOptions = {}): Promise<Datom[]> {
    // For asOf queries, only query committed state (ignore pending changes)
    if (options.asOf !== undefined) {
      return this.db.query(options);
    }

    // Query committed data
    const committed = await this.db.query(options);

    // Merge with pending changes
    const pending = this.mergePendingChanges(committed, options);
    return pending;
  }

  async queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]> {
    // Query committed state at that transaction, ignoring pending changes
    return this.db.query({ ...options, asOf: tx });
  }

  async add(datoms: DatomInput[]): Promise<TransactionId> {
    for (const datom of datoms) {
      const d: Datom = {
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx: this.txId,
        added: true,
      };
      this.pendingAdds.push(d);
    }
    return this.txId;
  }

  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    for (const datom of datoms) {
      const key = `${String(datom[0])}|${String(datom[1])}|${String(datom[2])}`;

      // Remove from pending adds if it was added in this transaction
      this.pendingAdds = this.pendingAdds.filter((d) => {
        const dKey = `${String(d.entity)}|${String(d.attribute)}|${String(
          d.value
        )}`;
        return dKey !== key;
      });

      // Add to pending retracts
      const d: Datom = {
        entity: datom[0],
        attribute: datom[1],
        value: datom[2],
        tx: this.txId,
        added: false,
      };
      this.pendingRetracts.push(d);
    }
    return this.txId;
  }

  async queryDatalog(query: DatalogQuery): Promise<QueryResult> {
    return this.executeDatalogWithTransaction(query);
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

  async commit(): Promise<void> {
    // Apply all pending changes to the database
    if (this.pendingAdds.length > 0) {
      const placeholders = this.pendingAdds
        .map(() => "(?, ?, ?, ?, ?)")
        .join(", ");
      const sql = `
        INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;

      const params = this.pendingAdds.flatMap((d) => {
        let value = d.value;
        if (value === undefined) {
          value = "__UNDEFINED__";
        }
        if (typeof value === "symbol") {
          value = `__SYMBOL__${String(value)}`;
        }
        return [
          String(d.entity),
          String(d.attribute),
          JSON.stringify(value),
          this.txId,
          true,
        ];
      });

      await this.connection.execute(sql, params);
    }
    if (this.pendingRetracts.length > 0) {
      const placeholders = this.pendingRetracts
        .map(() => "(?, ?, ?, ?, ?)")
        .join(", ");
      const sql = `
        INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;

      const params = this.pendingRetracts.flatMap((d) => {
        let value = d.value;
        if (value === undefined) {
          value = "__UNDEFINED__";
        }
        if (typeof value === "symbol") {
          value = `__SYMBOL__${String(value)}`;
        }
        return [
          String(d.entity),
          String(d.attribute),
          JSON.stringify(value),
          this.txId,
          false,
        ];
      });

      await this.connection.execute(sql, params);
    }
  }

  private mergePendingChanges(
    committed: Datom[],
    options: QueryOptions
  ): Datom[] {
    // Create a map of committed datoms by (entity, attribute, value)
    // This supports multi-valued attributes (multiple values per attribute)
    const committedMap = new Map<string, Datom>();
    for (const datom of committed) {
      const key = `${String(datom.entity)}|${String(datom.attribute)}|${String(
        datom.value
      )}`;
      const existing = committedMap.get(key);
      if (!existing || datom.tx > existing.tx) {
        committedMap.set(key, datom);
      }
    }

    // Apply pending retracts (remove matching datoms)
    // Retracts match by (entity, attribute, value) to remove specific values
    for (const retract of this.pendingRetracts) {
      const key = `${String(retract.entity)}|${String(
        retract.attribute
      )}|${String(retract.value)}`;
      committedMap.delete(key);
    }

    // Apply pending adds (add or update datoms)
    // Adds update the state of (entity, attribute, value) combinations
    for (const add of this.pendingAdds) {
      const key = `${String(add.entity)}|${String(add.attribute)}|${String(
        add.value
      )}`;
      committedMap.set(key, add);
    }

    let results = Array.from(committedMap.values());

    // Apply filters from options
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

    // Handle added filter
    if (options.added === undefined || options.added === true) {
      results = results.filter((d) => d.added);
    } else if (options.added === false) {
      results = results.filter((d) => !d.added);
    }

    // Sort by entity, then attribute
    results.sort((a, b) => {
      let entityA: number;
      if (typeof a.entity === "number") {
        entityA = a.entity;
      } else {
        const entityStr = String(a.entity);
        entityA = /^-?\d+$/.test(entityStr) ? parseInt(entityStr, 10) : 0;
      }

      let entityB: number;
      if (typeof b.entity === "number") {
        entityB = b.entity;
      } else {
        const entityStr = String(b.entity);
        entityB = /^-?\d+$/.test(entityStr) ? parseInt(entityStr, 10) : 0;
      }

      if (entityA !== entityB) {
        return entityA - entityB;
      }
      return String(a.attribute).localeCompare(String(b.attribute));
    });

    // Apply pagination
    const offset = options.offset ?? 0;
    const paginated = options.limit
      ? results.slice(offset, offset + options.limit)
      : results.slice(offset);

    return paginated;
  }

  private async executeDatalogWithTransaction(
    query: DatalogQuery
  ): Promise<QueryResult> {
    if (query.where.length === 0) {
      return [];
    }

    const firstClause = query.where[0];
    const firstResults = await this.executeClause(firstClause, query.asOf);

    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      const clauseResults = await this.executeClause(clause, query.asOf);
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

  private async executeClause(
    clause: QueryClause,
    asOf?: TransactionId
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
      asOf,
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
