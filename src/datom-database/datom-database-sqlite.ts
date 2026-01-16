/**
 * SQLite database implementation
 * Accepts a SqlConnection interface for SQLite-compatible databases
 */

import { DatomDatabase, type Transaction } from "./datom-database.js";
import type {
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
import type { SQLDatabase } from "../sql-database/sql-database.js";

/**
 * SQLite database implementation
 * Accepts a SqlDatabase that implements SQLite-compatible SQL
 */
export class SQLiteDatomDatabase extends DatomDatabase {
  private connection: SQLDatabase;
  private tableName: string;
  protected initialized = false;
  private queryCount: number = 0;
  private transactionCount: number = 0;
  private queryTimeSum: number = 0;
  private transactionTimeSum: number = 0;

  constructor(connection: SQLDatabase, tableName: string = "datoms") {
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

      // Optimized composite indexes for common query patterns
      const indexes = [
        // Composite index for entity+attribute queries (most common pattern)
        // SQLite doesn't support DESC in index definition, but this helps with filtering
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_entity_attr_tx ON ${this.tableName}(entity, attribute, tx)`,
        // Composite index for attribute+value queries
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_attr_value_tx ON ${this.tableName}(attribute, value, tx)`,
        // Index on tx for transaction-based queries (DESC ordering handled in query)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx)`,
        // Covering index for entity lookups
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_entity ON ${this.tableName}(entity)`,
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

  protected async addDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();
    await this.addDatomsInternal(datoms, tx);
    return tx;
  }

  protected async retractDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this.getNextTransactionId();
    await this.retractDatomsInternal(datoms, tx);
    return tx;
  }

  async retractEntity(entity: EntityId): Promise<TransactionId> {
    await this.ensureInitialized();
    // Get all datoms for this entity
    const entityDatoms = await this.executeQuery({ entity, added: true });

    // Retract all of them
    if (entityDatoms.length > 0) {
      const retractions: DatomInput[] = entityDatoms.map((d) => [
        d.entity,
        d.attribute,
        d.value,
      ]);
      return this.retract(retractions);
    }

    // Return current transaction ID even if nothing to retract
    return await this.getNextTransactionId();
  }

  protected async executeQuery(options: QueryOptions): Promise<Datom[]> {
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
      // Serialize entity properly (handles symbols)
      let entityStr: string;
      if (typeof options.entity === "symbol") {
        const desc =
          options.entity.description ?? String(options.entity).slice(7, -1);
        entityStr = `__SYMBOL__${desc}`;
      } else {
        entityStr = String(options.entity);
      }
      params.push(entityStr);
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
        const desc = value.description ?? String(value).slice(7, -1);
        value = `__SYMBOL__${desc}`;
      }
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Check if this is a history query
    const isHistoryQuery = options.history === true;

    // For history queries, return all datoms ordered by tx
    if (isHistoryQuery) {
      const limitClause = options.limit ? "LIMIT ?" : "";
      const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

      const sql = `
        SELECT entity, attribute, value, tx, added
        FROM ${this.tableName}
        ${whereClause}
        ORDER BY tx ASC, entity ASC, attribute ASC
        ${limitClause}
        ${offsetClause}
      `;

      if (options.limit) {
        params.push(options.limit);
      }
      if (options.offset !== undefined) {
        params.push(options.offset);
      }

      const rows = await this.connection.query(sql, params);

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

      return rows.map((row: any) => {
        let entity: any = row.entity;
        if (typeof entity === "string") {
          if (entity.startsWith("__SYMBOL__")) {
            const symbolDesc = entity.substring("__SYMBOL__".length);
            entity = Symbol(symbolDesc);
          } else if (/^-?\d+$/.test(entity)) {
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
          added: Boolean(row.added),
        };
      });
    }

    // Use SQL-level deduplication with ROW_NUMBER() window function
    // For time-travel queries (asOf), deduplicate by (entity, attribute) to get latest value per attribute
    // For regular queries, deduplicate by (entity, attribute, value) to support multi-valued attributes
    const partitionByColumns =
      options.asOf !== undefined
        ? "entity, attribute"
        : "entity, attribute, value";

    // Build the added filter
    let addedFilter = "";
    if (options.added === true || options.added === undefined) {
      addedFilter = "AND added = 1";
    } else if (options.added === false) {
      addedFilter = "AND added = 0";
    }

    const limitClause = options.limit ? "LIMIT ?" : "";
    const offsetClause = options.offset !== undefined ? "OFFSET ?" : "";

    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          entity,
          attribute,
          value,
          tx,
          added,
          ROW_NUMBER() OVER (
            PARTITION BY ${partitionByColumns}
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        entity,
        attribute,
        value,
        tx,
        added
      FROM ranked_datoms
      WHERE rn = 1
      ${addedFilter}
      ORDER BY
        CASE 
          WHEN entity GLOB '-[0-9]*' OR entity GLOB '[0-9]*' THEN CAST(entity AS INTEGER)
          ELSE 0
        END,
        attribute
      ${limitClause}
      ${offsetClause}
    `;

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.connection.query(sql, params);

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

    return rows.map((row: any) => {
      let entity: any = row.entity;
      if (typeof entity === "string") {
        if (entity.startsWith("__SYMBOL__")) {
          const symbolDesc = entity.substring("__SYMBOL__".length);
          entity = Symbol(symbolDesc);
        } else if (/^-?\d+$/.test(entity)) {
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
        added: Boolean(row.added),
      };
    });
  }

  async explainQuery(options: QueryOptions): Promise<QueryExplainResult> {
    await this.ensureInitialized();
    const result = await super.explainQuery(options);

    // Build the same query as executeQuery to explain it
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.asOf !== undefined) {
      conditions.push("tx <= ?");
      params.push(options.asOf);
    }
    if (options.entity !== undefined) {
      conditions.push("entity = ?");
      // Serialize entity properly (handles symbols)
      let entityStr: string;
      if (typeof options.entity === "symbol") {
        const desc =
          options.entity.description ?? String(options.entity).slice(7, -1);
        entityStr = `__SYMBOL__${desc}`;
      } else {
        entityStr = String(options.entity);
      }
      params.push(entityStr);
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
        const desc = value.description ?? String(value).slice(7, -1);
        value = `__SYMBOL__${desc}`;
      }
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push("tx = ?");
      params.push(options.tx);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const isHistoryQuery = options.history === true;
    let explainSql: string;

    if (isHistoryQuery) {
      explainSql = `
        EXPLAIN QUERY PLAN
        SELECT entity, attribute, value, tx, added
        FROM ${this.tableName}
        ${whereClause}
        ORDER BY tx ASC, entity ASC, attribute ASC
      `;
    } else {
      const partitionByColumns =
        options.asOf !== undefined
          ? "entity, attribute"
          : "entity, attribute, value";
      const addedFilter =
        options.added === true || options.added === undefined
          ? "AND added = 1"
          : options.added === false
          ? "AND added = 0"
          : "";

      explainSql = `
        EXPLAIN QUERY PLAN
        WITH ranked_datoms AS (
          SELECT 
            entity,
            attribute,
            value,
            tx,
            added,
            ROW_NUMBER() OVER (
              PARTITION BY ${partitionByColumns}
              ORDER BY tx DESC
            ) AS rn
          FROM ${this.tableName}
          ${whereClause}
        )
        SELECT 
          entity,
          attribute,
          value,
          tx,
          added
        FROM ranked_datoms
        WHERE rn = 1
        ${addedFilter}
      `;
    }

    try {
      const explainRows = await this.connection.query(explainSql, params);
      result.raw = explainRows;

      // Parse SQLite EXPLAIN QUERY PLAN output
      // Format: {selectid, order, from, detail}
      const indexesUsedSet = new Set<string>();
      let scanTypeDetected: "index" | "full-table" | "index-only" | "unknown" =
        "unknown";

      for (const row of explainRows as any[]) {
        const detail = String(row.detail || "");
        const from = String(row.from || "");

        // Detect scan types
        if (detail.includes("SCAN TABLE") || from.includes("SCAN TABLE")) {
          scanTypeDetected = "full-table";
        } else if (
          detail.includes("SEARCH TABLE") ||
          from.includes("SEARCH TABLE")
        ) {
          scanTypeDetected = "index";
        } else if (
          detail.includes("SCAN") &&
          (detail.includes("COVERING INDEX") || detail.includes("INDEX"))
        ) {
          scanTypeDetected = "index-only";
        }

        // Extract index names
        const indexMatch = detail.match(/USING INDEX (\w+)/i);
        if (indexMatch) {
          indexesUsedSet.add(indexMatch[1]);
        }
        const indexMatch2 = detail.match(/INDEX (\w+)/i);
        if (indexMatch2 && !detail.includes("USING INDEX")) {
          indexesUsedSet.add(indexMatch2[1]);
        }
      }

      if (scanTypeDetected !== "unknown") {
        result.scanType = scanTypeDetected;
      }

      if (indexesUsedSet.size > 0) {
        result.indexesUsed = Array.from(indexesUsedSet);
      }

      // Estimate rows based on query plan detail
      // SQLite doesn't provide row estimates in EXPLAIN QUERY PLAN, but we can infer from scan type
      if (scanTypeDetected === "full-table") {
        result.warnings = result.warnings || [];
        result.warnings.push(
          "Query plan indicates full table scan. Consider adding indexes on frequently queried attributes."
        );
      }
    } catch (error) {
      // If EXPLAIN fails, return base result with warning
      result.warnings = result.warnings || [];
      result.warnings.push(
        `Failed to get query plan: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return result;
  }

  async queryDatalog(query: DatalogQuery): Promise<QueryResult> {
    await this.ensureInitialized();
    if (query.where.length === 0) {
      return [];
    }

    // For single clause queries, use the optimized query method
    if (query.where.length === 1) {
      const clause = query.where[0];
      const [entityVal, attributeVal, valueVal] = clause;
      const entity = this.isVariable(entityVal)
        ? undefined
        : (entityVal as EntityId);
      const attribute = this.isVariable(attributeVal)
        ? undefined
        : (attributeVal as string);
      const value = this.isVariable(valueVal) ? undefined : (valueVal as Value);

      const datoms = await this.executeQuery({
        entity,
        attribute,
        value,
        asOf: query.asOf,
        added: true,
      });

      const results = datoms.map((datom) => {
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

      const projected = this.project(results, query.find, query.where);
      return this.applyOrderAndLimit(projected, query);
    }

    // For multi-clause queries, build a single SQL query with JOINs
    return this.executeDatalogWithSQL(query);
  }

  private async executeDatalogWithSQL(
    query: DatalogQuery
  ): Promise<QueryResult> {
    const clauses = query.where;
    const params: any[] = [];
    const ctes: string[] = [];
    const joins: string[] = [];
    const selectColumns: string[] = [];
    const joinConditions: string[] = [];

    // Build CTEs for each clause with deduplication
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      const [entityVal, attributeVal, valueVal] = clause;
      const alias = `d${i}`;

      const conditions: string[] = [];
      if (query.asOf !== undefined) {
        conditions.push(`tx <= ?`);
        params.push(query.asOf);
      }

      // Add filters for bound values
      if (!this.isVariable(entityVal)) {
        conditions.push(`entity = ?`);
        // Serialize entity properly (handles symbols)
        let entityStr: string;
        if (typeof entityVal === "symbol") {
          const desc = entityVal.description ?? String(entityVal).slice(7, -1);
          entityStr = `__SYMBOL__${desc}`;
        } else {
          entityStr = String(entityVal);
        }
        params.push(entityStr);
      }
      if (!this.isVariable(attributeVal)) {
        conditions.push(`attribute = ?`);
        params.push(String(attributeVal));
      }
      if (!this.isVariable(valueVal)) {
        let value = valueVal as Value;
        if (value === undefined) {
          value = "__UNDEFINED__";
        }
        if (typeof value === "symbol") {
          const desc = value.description ?? String(value).slice(7, -1);
          value = `__SYMBOL__${desc}`;
        }
        conditions.push(`value = ?`);
        params.push(JSON.stringify(value));
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Use ROW_NUMBER for deduplication
      const partitionBy =
        query.asOf !== undefined
          ? "entity, attribute"
          : "entity, attribute, value";

      const rankedCte = `
        ${alias}_ranked AS (
          SELECT 
            entity,
            attribute,
            value,
            tx,
            added,
            ROW_NUMBER() OVER (
              PARTITION BY ${partitionBy}
              ORDER BY tx DESC
            ) AS rn
          FROM ${this.tableName}
          ${whereClause}
        )`;

      const cte = `
        ${alias} AS (
          SELECT entity, attribute, value, tx
          FROM ${alias}_ranked
          WHERE rn = 1 AND added = 1
        )`;

      // Store ranked CTE separately, then the final CTE
      ctes.push(rankedCte);
      ctes.push(cte);

      // Build SELECT columns for variables
      if (this.isVariable(entityVal)) {
        selectColumns.push(
          `${alias}.entity AS ${this.escapeColumnName(entityVal as string)}`
        );
      }
      if (this.isVariable(attributeVal)) {
        selectColumns.push(
          `${alias}.attribute AS ${this.escapeColumnName(
            attributeVal as string
          )}`
        );
      }
      if (this.isVariable(valueVal)) {
        selectColumns.push(
          `${alias}.value AS ${this.escapeColumnName(valueVal as string)}`
        );
      }
    }

    // Build JOIN conditions based on shared variables
    const variableToClause: Map<
      string,
      { clauseIndex: number; field: string }[]
    > = new Map();

    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      const [entityVal, attributeVal, valueVal] = clause;

      if (this.isVariable(entityVal)) {
        const varName = entityVal as string;
        if (!variableToClause.has(varName)) {
          variableToClause.set(varName, []);
        }
        variableToClause
          .get(varName)!
          .push({ clauseIndex: i, field: "entity" });
      }
      if (this.isVariable(attributeVal)) {
        const varName = attributeVal as string;
        if (!variableToClause.has(varName)) {
          variableToClause.set(varName, []);
        }
        variableToClause
          .get(varName)!
          .push({ clauseIndex: i, field: "attribute" });
      }
      if (this.isVariable(valueVal)) {
        const varName = valueVal as string;
        if (!variableToClause.has(varName)) {
          variableToClause.set(varName, []);
        }
        variableToClause.get(varName)!.push({ clauseIndex: i, field: "value" });
      }
    }

    // Build JOIN conditions for shared variables
    for (const [varName, occurrences] of variableToClause.entries()) {
      if (occurrences.length > 1) {
        // This variable appears in multiple clauses, need to join on it
        for (let i = 1; i < occurrences.length; i++) {
          const prev = occurrences[i - 1];
          const curr = occurrences[i];
          const prevAlias = `d${prev.clauseIndex}`;
          const currAlias = `d${curr.clauseIndex}`;
          joinConditions.push(
            `${prevAlias}.${prev.field} = ${currAlias}.${curr.field}`
          );
        }
      }
    }

    // Build the final SQL query
    const cteClause = ctes.length > 0 ? `WITH ${ctes.join(", ")}` : "";
    const fromClause = `FROM d0`;

    // Build JOIN clauses properly - each table needs its own JOIN with conditions
    const joinClauses: string[] = [];
    for (let i = 1; i < clauses.length; i++) {
      const alias = `d${i}`;
      const conditions: string[] = [];

      // Find all join conditions involving this alias
      for (const joinCond of joinConditions) {
        if (joinCond.includes(`${alias}.`)) {
          // Extract the condition that connects this alias to a previous one
          const parts = joinCond.split(" = ");
          if (parts.length === 2) {
            if (parts[1].startsWith(`${alias}.`)) {
              conditions.push(joinCond);
            } else if (parts[0].startsWith(`${alias}.`)) {
              // Reverse the condition
              conditions.push(`${parts[1]} = ${parts[0]}`);
            }
          }
        }
      }

      if (conditions.length > 0) {
        // Find the first alias this joins to
        const firstCond = conditions[0];
        const otherAlias = firstCond.includes("d0.")
          ? "d0"
          : firstCond.match(/d\d+/)?.find((a) => a !== alias) || "d0";
        joinClauses.push(`JOIN ${alias} ON ${conditions.join(" AND ")}`);
      } else {
        // Cross join if no conditions (shouldn't happen in practice)
        joinClauses.push(`CROSS JOIN ${alias}`);
      }
    }

    const joinClause = joinClauses.join(" ");

    // Build ORDER BY clause
    let orderByClause = "";
    if (query.orderBy && query.orderBy.length > 0) {
      const orderParts = query.orderBy
        .map(([variable, direction]) => {
          // Find which clause/alias has this variable
          for (let i = 0; i < clauses.length; i++) {
            const clause = clauses[i];
            const [entityVal, attributeVal, valueVal] = clause;
            if (entityVal === variable) {
              return `d${i}.entity ${direction.toUpperCase()}`;
            }
            if (attributeVal === variable) {
              return `d${i}.attribute ${direction.toUpperCase()}`;
            }
            if (valueVal === variable) {
              return `d${i}.value ${direction.toUpperCase()}`;
            }
          }
          return "";
        })
        .filter(Boolean);
      if (orderParts.length > 0) {
        orderByClause = `ORDER BY ${orderParts.join(", ")}`;
      }
    }

    const limitClause = query.limit ? `LIMIT ?` : "";
    if (query.limit) {
      params.push(query.limit);
    }

    const sql = `
      ${cteClause}
      SELECT ${selectColumns.join(", ")}
      ${fromClause}
      ${joinClause}
      ${orderByClause}
      ${limitClause}
    `;

    const rows = await this.connection.query(sql, params);

    // Convert SQL results back to QueryResult format
    const results: QueryResult = rows.map((row: any) => {
      const result: Record<string, Value> = {};
      for (const key of Object.keys(row)) {
        let value = row[key];
        // Parse JSON values - values are stored as JSON strings in SQLite
        if (typeof value === "string") {
          try {
            // Try parsing as JSON first (handles numbers, booleans, objects, arrays, etc.)
            value = JSON.parse(value);
          } catch {
            // Not valid JSON, keep as string
          }
        }
        result[key] = this.reviveValue(value);
      }
      return result;
    });

    // Apply projection if needed
    if (query.find.length > 0) {
      return results.map((row) => {
        const projected: Record<string, Value> = {};
        for (const varName of query.find) {
          if (varName in row) {
            projected[varName] = row[varName];
          }
        }
        return projected;
      });
    }

    return results;
  }

  private escapeColumnName(name: string): string {
    // SQLite column aliases can be quoted or unquoted
    // For safety, quote them if they contain special characters
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return name;
    }
    return `"${name.replace(/"/g, '""')}"`;
  }

  private reviveValue(value: any): any {
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
      // Try parsing as JSON if it looks like JSON
      if (
        (value.startsWith("{") || value.startsWith("[")) &&
        value.length > 1
      ) {
        try {
          const parsed = JSON.parse(value);
          return this.reviveValue(parsed);
        } catch {
          // Not valid JSON, return as string
        }
      }
    }
    if (value === null) {
      return null;
    }
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.reviveValue(v));
    }
    if (typeof value === "object") {
      const revived: any = {};
      for (const key in value) {
        revived[key] = this.reviveValue(value[key]);
      }
      return revived;
    }
    return value;
  }

  private applyOrderAndLimit(
    results: QueryResult,
    query: DatalogQuery
  ): QueryResult {
    if (query.orderBy) {
      results.sort((a, b) => {
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
      return results.slice(0, query.limit);
    }

    return results;
  }

  async getEntity(entity: EntityId): Promise<Datom[]> {
    await this.ensureInitialized();
    return this.query({ entity, added: true });
  }

  protected async executeTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    isolationLevel?: import("../types.js").TransactionIsolationLevel
  ): Promise<T> {
    // Note: SQLite isolation level support would require PRAGMA isolation_level
    // For now, we use the database default (SERIALIZABLE in SQLite)
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
    // Optimized: Use INSERT ... ON CONFLICT to atomically initialize and update
    // This reduces from 3 queries to 2 queries (init+update combined, then select)
    const upsertSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      VALUES (1, 0)
      ON CONFLICT(id) DO UPDATE SET last_tx = last_tx + 1
    `;
    await this.connection.execute(upsertSql);

    // Retrieve the updated value
    const selectSql = `
      SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1
    `;
    const result = await this.connection.query(selectSql);
    if (!result || result.length === 0) {
      throw new Error("Transaction counter row not found after update");
    }
    return result[0].last_tx;
  }

  private async addDatomsInternal(
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
        const desc = value.description ?? String(value).slice(7, -1);
        value = `__SYMBOL__${desc}`;
      }
      // Serialize entity properly (handles symbols)
      let entityStr: string;
      if (typeof d[0] === "symbol") {
        const desc = d[0].description ?? String(d[0]).slice(7, -1);
        entityStr = `__SYMBOL__${desc}`;
      } else {
        entityStr = String(d[0]);
      }
      return [entityStr, String(d[1]), JSON.stringify(value), tx, true];
    });

    await this.connection.execute(sql, params);
  }

  private async retractDatomsInternal(
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
        const desc = value.description ?? String(value).slice(7, -1);
        value = `__SYMBOL__${desc}`;
      }
      // Serialize entity properly (handles symbols)
      let entityStr: string;
      if (typeof d[0] === "symbol") {
        const desc = d[0].description ?? String(d[0]).slice(7, -1);
        entityStr = `__SYMBOL__${desc}`;
      } else {
        entityStr = String(d[0]);
      }
      return [entityStr, String(d[1]), JSON.stringify(value), tx, false];
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

    // Datalog queries manage their own limiting via joins, so bypass validation
    const queryOptions: QueryOptions = {
      ...(entity !== undefined && { entity }),
      ...(attribute !== undefined && { attribute }),
      ...(value !== undefined && { value }),
      ...(asOf !== undefined && { asOf }),
    };

    const datoms = await this.queryInternal(queryOptions);

    return datoms.map((datom: Datom) => {
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

  /**
   * Get metadata associated with a transaction
   * Default implementation returns undefined (metadata storage not implemented)
   * Override onTransactionMetadata and this method to support metadata storage
   */
  async getTransactionMetadata(
    txId: TransactionId
  ): Promise<Record<string, unknown> | undefined> {
    // Default: no metadata storage
    return undefined;
  }

  async getLatestTransaction(): Promise<TransactionId> {
    await this.ensureInitialized();
    const sql = `SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1`;
    const result = await this.connection.query(sql);
    if (!result || result.length === 0) {
      // No transactions yet
      return 0;
    }
    return result[0].last_tx;
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
    const stats: any = {};

    // Count total datoms (only added ones, latest version)
    const countSql = `
      WITH latest_datoms AS (
        SELECT entity, attribute, value, tx, added,
               ROW_NUMBER() OVER (PARTITION BY entity, attribute, value ORDER BY tx DESC) as rn
        FROM ${this.tableName}
      )
      SELECT COUNT(*) as count
      FROM latest_datoms
      WHERE rn = 1 AND added = 1
    `;
    const countResult = await this.connection.query(countSql);
    stats.totalDatoms = countResult[0]?.count ?? 0;

    // Count unique entities
    const entitySql = `
      SELECT COUNT(DISTINCT entity) as count
      FROM ${this.tableName}
      WHERE added = 1
    `;
    const entityResult = await this.connection.query(entitySql);
    stats.totalEntities = entityResult[0]?.count ?? 0;

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
 * SQLite transaction implementation
 * Tracks pending changes and merges them with queries
 */
class SQLiteTransaction implements Transaction {
  private connection: SQLDatabase;
  private tableName: string;
  private txId: TransactionId;
  private db: SQLiteDatomDatabase;
  private pendingAdds: Datom[] = [];
  private pendingRetracts: Datom[] = [];

  constructor(
    connection: SQLDatabase,
    tableName: string,
    txId: TransactionId,
    db: SQLiteDatomDatabase
  ) {
    this.connection = connection;
    this.tableName = tableName;
    this.txId = txId;
    this.db = db;
  }

  getTransactionId(): TransactionId {
    return this.txId;
  }

  async query(options: QueryOptions): Promise<Datom[]> {
    // For asOf queries, only query committed state (ignore pending changes)
    if (options.asOf !== undefined) {
      return this.db._queryInternalForTransaction(options);
    }

    // Query committed data (bypass validation since transactions manage their own constraints)
    const committed = await this.db._queryInternalForTransaction(options);

    // Merge with pending changes
    const pending = this.mergePendingChanges(committed, options);
    return pending;
  }

  async explainQuery(options: QueryOptions): Promise<QueryExplainResult> {
    // Delegate to database's explainQuery
    return this.db.explainQuery(options);
  }

  async queryAsOf(tx: TransactionId, options?: QueryOptions): Promise<Datom[]> {
    // Query committed state at that transaction, ignoring pending changes
    return this.db._queryInternalForTransaction({ ...options, asOf: tx });
  }

  async add(datoms: DatomInput[]): Promise<void> {
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
  }

  async retract(datoms: DatomInput[]): Promise<void> {
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
  }

  async retractEntity(entity: EntityId): Promise<void> {
    // Get all datoms for this entity that are currently visible
    const entityDatoms = await this.query({ entity, added: true });

    // Retract all of them
    const retractions: DatomInput[] = entityDatoms.map((d) => [
      d.entity,
      d.attribute,
      d.value,
    ]);
    await this.retract(retractions);
  }

  async retractAttribute(entity: EntityId, attribute: string): Promise<void> {
    // Get all current values for this entity-attribute pair
    const datoms = await this.query({ entity, attribute });
    if (datoms.length === 0) {
      return;
    }
    // Retract all existing values
    const toRetract: DatomInput[] = datoms.map((d) => [
      d.entity,
      d.attribute,
      d.value,
    ]);
    await this.retract(toRetract);
  }

  async upsert(
    entity: EntityId,
    attribute: string,
    value: Value
  ): Promise<void> {
    const definition = this.db.getAttributeDefinition(attribute);

    // If cardinality is "one", retract existing value first
    if (definition?.cardinality === "one") {
      const existingValues = await this.getValues(entity, attribute);
      const toRetract: DatomInput[] = existingValues.map((v) => [
        entity,
        attribute,
        v,
      ]);
      if (toRetract.length > 0) {
        await this.retract(toRetract);
      }
    }

    // Add the new value
    await this.add([[entity, attribute, value]]);
  }

  async getLatestValue(
    entity: EntityId,
    attribute: string
  ): Promise<Value | undefined> {
    return this.getValue(entity, attribute);
  }

  async transact(ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }): Promise<void> {
    if (ops.add && ops.add.length > 0) {
      await this.add(ops.add);
    }
    if (ops.retract && ops.retract.length > 0) {
      await this.retract(ops.retract);
    }
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
    if (datoms.length === 0) {
      return undefined;
    }
    // Return the value with the highest tx (latest value for this attribute)
    const sorted = datoms.sort((a, b) => b.tx - a.tx);
    return sorted[0].value;
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

  async getValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<(Value | undefined)[]> {
    const results = await Promise.all(
      queries.map((q) => this.getValue(q.entity, q.attribute))
    );
    return results;
  }

  async getAllValuesBatch(
    queries: Array<{ entity: EntityId; attribute: string }>
  ): Promise<Value[][]> {
    const results = await Promise.all(
      queries.map((q) => this.getValues(q.entity, q.attribute))
    );
    return results;
  }

  async findEntities(attribute: string, value: Value): Promise<EntityId[]> {
    const datoms = await this.query({ attribute, value });
    const entitySet = new Set<EntityId>();
    for (const datom of datoms) {
      entitySet.add(datom.entity);
    }
    return Array.from(entitySet);
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
          const desc = value.description ?? String(value).slice(7, -1);
          value = `__SYMBOL__${desc}`;
        }
        // Serialize entity properly (handles symbols)
        let entityStr: string;
        if (typeof d.entity === "symbol") {
          const desc = d.entity.description ?? String(d.entity).slice(7, -1);
          entityStr = `__SYMBOL__${desc}`;
        } else {
          entityStr = String(d.entity);
        }
        return [
          entityStr,
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
          const desc = value.description ?? String(value).slice(7, -1);
          value = `__SYMBOL__${desc}`;
        }
        // Serialize entity properly (handles symbols)
        let entityStr: string;
        if (typeof d.entity === "symbol") {
          const desc = d.entity.description ?? String(d.entity).slice(7, -1);
          entityStr = `__SYMBOL__${desc}`;
        } else {
          entityStr = String(d.entity);
        }
        return [
          entityStr,
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

    // Use transaction's query method to see uncommitted changes
    const queryOptions: QueryOptions = {
      ...(entity !== undefined && { entity }),
      ...(attribute !== undefined && { attribute }),
      ...(value !== undefined && { value }),
      ...(asOf !== undefined && { asOf }),
    };

    const datoms = await this.query(queryOptions);

    return datoms.map((datom: Datom) => {
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
