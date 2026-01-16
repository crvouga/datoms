/**
 * PostgreSQL database implementation
 * Accepts a SqlConnection interface for PostgreSQL-compatible databases
 */

import { Database } from "./database.js";
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
 * PostgreSQL database implementation
 * Accepts a SqlConnection that implements PostgreSQL-compatible SQL
 */
export class PostgreSQLDatabase extends Database {
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
          value JSONB NOT NULL,
          tx BIGINT NOT NULL,
          added BOOLEAN NOT NULL,
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
          id BIGINT PRIMARY KEY,
          last_tx BIGINT NOT NULL DEFAULT 0
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

    if (
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    ) {
      await this.connection.beginTransaction();
      try {
        await this.addDatoms(datoms, tx);
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    } else {
      await this.addDatoms(datoms, tx);
    }

    return tx;
  }

  async retract(datoms: DatomInput[]): Promise<TransactionId> {
    await this.ensureInitialized();
    const tx = await this.getNextTransactionId();

    if (
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    ) {
      await this.connection.beginTransaction();
      try {
        await this.retractDatoms(datoms, tx);
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction();
        throw error;
      }
    } else {
      await this.retractDatoms(datoms, tx);
    }

    return tx;
  }

  async query(options: QueryOptions = {}): Promise<Datom[]> {
    await this.ensureInitialized();
    const conditions: string[] = [];
    const params: any[] = [];

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

    const sql = `
      SELECT entity, attribute, value, tx, added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx DESC
    `;

    const rows = await this.connection.query(sql, params);

    const latestDatoms = new Map<string, any>();
    for (const row of rows) {
      const key = `${row.entity}|${row.attribute}|${row.value}`;
      const existing = latestDatoms.get(key);
      if (!existing || row.tx > existing.tx) {
        latestDatoms.set(key, row);
      }
    }

    let results = Array.from(latestDatoms.values());

    if (options.added === undefined || options.added === true) {
      results = results.filter((r) => r.added);
    } else if (options.added === false) {
      results = results.filter((r) => !r.added);
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
        added: row.added,
      };
    });
  }

  async queryDatalog(query: DatalogQuery): Promise<QueryResult> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();
    return this.query({ entity, added: true });
  }

  /**
   * Clean up tables for test isolation
   * This method can be called before each test to ensure a clean state
   */
  async cleanup(): Promise<void> {
    await this.ensureInitialized();
    await this.connection.execute(
      `TRUNCATE TABLE ${this.tableName}, ${this.tableName}_tx RESTART IDENTITY CASCADE`
    );
    // Re-initialize transaction counter after truncate
    const initTxSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      SELECT 1, 0
      WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
    `;
    await this.connection.execute(initTxSql);
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
