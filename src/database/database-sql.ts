/**
 * SQL database implementation
 * Stores datoms in a SQL database and executes queries
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
import type { SqlConnection, SqlDialect } from "./sql-utils.js";

/**
 * SQL database implementation
 * Stores datoms in a SQL database
 */
export abstract class SqlDatabase extends Database {
  protected connection: SqlConnection;
  protected tableName: string;

  constructor(connection: SqlConnection, tableName: string = "datoms") {
    super();
    this.connection = connection;
    this.tableName = tableName;
  }

  /**
   * Get the SQL dialect-specific syntax
   */
  protected abstract getDialect(): SqlDialect;

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const dialect = this.getDialect();
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          entity ${dialect.textType} NOT NULL,
          attribute ${dialect.textType} NOT NULL,
          value ${dialect.jsonType} NOT NULL,
          tx ${dialect.integerType} NOT NULL,
          added ${dialect.booleanType} NOT NULL,
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
          id ${dialect.integerType} PRIMARY KEY,
          last_tx ${dialect.integerType} NOT NULL DEFAULT 0
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

    const supportsTx = this.supportsTransactions();
    if (supportsTx && this.connection.beginTransaction) {
      await this.connection.beginTransaction();
      try {
        await this.addDatoms(datoms, tx);
        if (this.connection.commitTransaction) {
          await this.connection.commitTransaction();
        }
      } catch (error) {
        if (this.connection.rollbackTransaction) {
          await this.connection.rollbackTransaction();
        }
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

    const supportsTx = this.supportsTransactions();
    if (supportsTx && this.connection.beginTransaction) {
      await this.connection.beginTransaction();
      try {
        await this.retractDatoms(datoms, tx);
        if (this.connection.commitTransaction) {
          await this.connection.commitTransaction();
        }
      } catch (error) {
        if (this.connection.rollbackTransaction) {
          await this.connection.rollbackTransaction();
        }
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
      // Handle undefined - use special marker
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      // Handle symbols - use special marker
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
    const limitClause = options.limit ? `LIMIT ${options.limit}` : "";
    const offsetClause = options.offset ? `OFFSET ${options.offset}` : "";

    // Get all matching rows ordered by transaction (most recent first)
    const sql = `
      SELECT entity, attribute, value, tx, added
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx DESC
    `;

    const rows = await this.connection.query(sql, params);

    // Handle retractions: for each unique (entity, attribute, value) combination,
    // keep only the most recent transaction
    // This ensures that retracted datoms are not returned when querying
    const latestDatoms = new Map<string, any>();
    for (const row of rows) {
      const key = `${row.entity}|${row.attribute}|${row.value}`;
      const existing = latestDatoms.get(key);
      if (!existing || row.tx > existing.tx) {
        latestDatoms.set(key, row);
      }
    }

    let results = Array.from(latestDatoms.values());

    // Filter by added flag
    if (options.added === undefined || options.added === true) {
      // Default to only added datoms
      results = results.filter((r) => r.added);
    } else if (options.added === false) {
      results = results.filter((r) => !r.added);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const paginated = options.limit
      ? results.slice(offset, offset + options.limit)
      : results.slice(offset);

    // Helper function to revive JSON values (convert date strings back to Date objects, etc.)
    const reviveValue = (value: any): any => {
      if (typeof value === "string") {
        // Check if it's our special undefined marker
        if (value === "__UNDEFINED__") {
          return undefined;
        }
        // Check if it's our special symbol marker
        if (value.startsWith("__SYMBOL__")) {
          // Extract the symbol description and create a new symbol
          // Note: This creates a new symbol, not the original, but it's the best we can do
          const symbolDesc = value.substring("__SYMBOL__".length);
          return Symbol(symbolDesc);
        }
        // Check if it's an ISO date string
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

    // Convert rows to Datom format, trying to preserve entity ID types
    return paginated.map((row: any) => {
      // Try to parse entity back to number if it looks like a number
      let entity: any = row.entity;
      if (typeof entity === "string") {
        // Check if it's a numeric string
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
    // For now, use in-memory query execution (can be optimized later with SQL-native queries)
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

  /**
   * Get the next transaction ID
   */
  private async getNextTransactionId(): Promise<TransactionId> {
    const dialect = this.getDialect();

    // First, ensure the row exists (in case it was deleted)
    // Use a dialect-agnostic approach: try to insert, ignore if exists
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

  /**
   * Add datoms to the database
   */
  private async addDatoms(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const dialect = this.getDialect();
    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ${dialect.onConflict || ""}
    `;

    const params = datoms.flatMap((d) => {
      let value = d[2];
      // Handle undefined - JSON.stringify(undefined) returns undefined, not a string
      // Use a special marker that we can detect when parsing
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      // Handle symbols - JSON.stringify(Symbol()) throws, so convert to string with marker
      if (typeof value === "symbol") {
        value = `__SYMBOL__${String(value)}`;
      }
      // Handle Date objects - JSON.stringify converts to ISO string, which is fine
      // but we'll detect and convert back in query
      return [
        String(d[0]), // entity
        String(d[1]), // attribute
        JSON.stringify(value), // value
        tx,
        true,
      ];
    });

    await this.connection.execute(sql, params);
  }

  /**
   * Retract datoms from the database
   */
  private async retractDatoms(
    datoms: DatomInput[],
    tx: TransactionId
  ): Promise<void> {
    if (datoms.length === 0) return;

    const dialect = this.getDialect();
    const placeholders = datoms.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO ${this.tableName} (entity, attribute, value, tx, added)
      VALUES ${placeholders}
      ${dialect.onConflict || ""}
    `;

    const params = datoms.flatMap((d) => {
      let value = d[2];
      // Handle undefined - JSON.stringify(undefined) returns undefined, not a string
      // Use a special marker that we can detect when parsing
      if (value === undefined) {
        value = "__UNDEFINED__";
      }
      // Handle symbols - JSON.stringify(Symbol()) throws, so convert to string with marker
      if (typeof value === "symbol") {
        value = `__SYMBOL__${String(value)}`;
      }
      return [
        String(d[0]), // entity
        String(d[1]), // attribute
        JSON.stringify(value), // value
        tx,
        false,
      ];
    });

    await this.connection.execute(sql, params);
  }

  /**
   * Check if transactions are supported
   */
  private supportsTransactions(): boolean {
    return !!(
      this.connection.beginTransaction &&
      this.connection.commitTransaction &&
      this.connection.rollbackTransaction
    );
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
