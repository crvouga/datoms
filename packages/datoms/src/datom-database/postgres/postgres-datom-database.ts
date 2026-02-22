/**
 * PostgreSQL database implementation
 * Accepts a SqlConnection interface for PostgreSQL-compatible databases
 */

import {
  isQueryPattern,
  isVariable,
  stripQuestionMark,
  type DatalogQuery,
  type DatalogQueryFindVariable,
  type DatalogQueryWhereClause,
  type DatalogQueryWhereClauseMatch,
} from '../../datalog-query.js';

import {
  type Attribute,
  type Datom,
  type DatomInput,
  type TransactionId,
  validateDatoms,
  type Value,
} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {SQLDatabase, SQLDatabaseTransaction} from '../../sql-database/sql-database.js';
import type {DatabaseRow} from '../../sql-database/types.js';
import type {Transaction} from '../../types.js';

import type {DatomDatabase, WithResult} from '../datom-database.js';
import {
  type Hook,
  HookEngine,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  type ReadContext,
  TransactionError,
  type WriteContext,
  type WriteResult,
} from '../hook/hook.js';
import {ConfiguredDatomDatabaseView} from '../configured-datom-database-view.js';
import type {DatomDatabaseView, QueryResult, QueryResultEnvelope} from '../datom-database-view.js';
import {datomsQueryToDatalogQuery, type DatomsQuery} from '../../datoms-query.js';
import type {DatomDatabaseViewConfig} from '../datom-database-view-config.js';
import {datalogToPostgresSQL} from './datalog-to-postgres-sql.js';

/**
 * PostgreSQL database implementation
 * Accepts a SqlDatabase that implements PostgreSQL-compatible SQL
 */
export class PostgreSQLDatomDatabase implements DatomDatabase {
  public readonly hooks: HookEngine;
  protected initialized = false;
  private sqlDb: SQLDatabase;
  private tableName: string;

  constructor({sqlDb, tableName = 'datoms'}: {sqlDb: SQLDatabase; tableName?: string}) {
    this.hooks = new HookEngine();
    this.sqlDb = sqlDb;
    this.tableName = tableName || 'datoms';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.sqlDb.transaction(async (tx) => {
      // 1. Create datoms table
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          e TEXT NOT NULL,
          a TEXT NOT NULL,
          v JSONB NOT NULL,
          tx BIGINT NOT NULL,
          op BOOLEAN NOT NULL,
          PRIMARY KEY (e, a, v, tx, op)
        )
      `;
      await tx.query(createTableSql);

      // 2. Create indexes
      const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e_a_tx ON ${this.tableName}(e, a, tx DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_v_tx ON ${this.tableName}(a, v, tx DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_active ON ${this.tableName}(e, a, tx DESC) WHERE op = true`,
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx DESC)`,
      ];

      for (const indexSql of indexes) {
        await tx.query(indexSql);
      }

      // 3. Create transaction counter table
      const txTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName}_tx (
          id BIGINT PRIMARY KEY,
          last_tx BIGINT NOT NULL DEFAULT 0
        )
      `;
      await tx.query(txTableSql);

      // 4. Initialize transaction counter if needed
      const initTxSql = `
        INSERT INTO ${this.tableName}_tx (id, last_tx)
        SELECT 1, 0
        WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
      `;
      await tx.query(initTxSql);
    });

    this.initialized = true;
  }

  hook(hook: Hook): void {
    this.hooks.register(hook);
  }

  private async _writeDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const txResult = await this._getNextTransactionId();
    const tx = txResult.txId;

    await this.sqlDb.transaction(async (transaction) => {
      await this._writeDatomsInternal(datoms, tx, transaction);
    });

    return tx;
  }

  async write(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Promise<TransactionId> {
    await this._ensureInitialized();

    // Create write context
    const ctx: WriteContext = {
      db: this,
      txMeta: metadata,
      ...(context || {}),
    };

    const datomInputs = ops.flat();
    validateDatoms(datomInputs);

    // Convert to datoms for transaction object
    const allDatoms: Datom[] = [];
    const latestTx = await this._getLatestTransaction();
    const txId = (latestTx.txId ?? 0) + 1;
    for (const datomInput of datomInputs) {
      allDatoms.push({...datomInput, tx: txId});
    }

    // Create transaction object
    const tx: Transaction = {
      txId: txId,
      datoms: allDatoms,
      meta: metadata,
    };

    // Run before-write hooks
    const beforeResult = await this.hooks.runBeforeWrite(tx, ctx);

    if (beforeResult.errors.length > 0) {
      throw new TransactionError('Transaction validation failed', beforeResult.errors);
    }

    // Combine all datoms from the modified transaction
    const finalTx = beforeResult.tx;
    const allFinalDatoms = finalTx.datoms.map((d) => ({
      e: d.e,
      a: d.a,
      v: d.v,
      op: d.op,
    }));

    // Write all datoms
    const committedTxId = await this._writeDatoms(allFinalDatoms);

    // Create write result for after-write hooks
    const writeResult: WriteResult = {
      txId: committedTxId,
      datoms: finalTx.datoms.map((d) => ({...d, tx: committedTxId})),
      timestamp: Date.now(),
    };

    // Run after-write hooks (fire and forget)
    this.hooks.runAfterWrite(writeResult, ctx).catch((err) => {
      console.error('After-write hook failed:', err);
    });

    return committedTxId;
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  asOf(txId: TransactionId): DatomDatabaseView {
    return new ConfiguredDatomDatabaseView(this, {type: 'asOf', txId});
  }

  history(): DatomDatabaseView {
    return new ConfiguredDatomDatabaseView(this, {type: 'history'});
  }

  since(txId: TransactionId): DatomDatabaseView {
    return new ConfiguredDatomDatabaseView(this, {type: 'since', txId});
  }

  async with(ops: DatomInput[]): Promise<WithResult> {
    await this._ensureInitialized();

    // Get the next transaction ID for speculative datoms
    const latestTx = await this._getLatestTransaction();
    const speculativeTxId = latestTx.txId + 1;

    // Process operations in sequence, creating speculative datoms directly
    const speculativeDatoms: Datom[] = [];

    for (const op of ops) {
      const speculativeDatom: Datom = {
        e: op.e,
        a: op.a,
        v: op.v,
        tx: speculativeTxId,
        op: op.op,
      };

      speculativeDatoms.push(speculativeDatom);
    }

    // Create dbBefore view (current state)
    const dbBefore = new ConfiguredDatomDatabaseView(this, {type: 'current'});

    // Create dbAfter view (speculative state)
    const dbAfter = new ConfiguredDatomDatabaseView(this, {
      type: 'speculative',
      datoms: speculativeDatoms,
    });

    // Generate txData (all datoms that would be applied)
    const txData: Datom[] = [...speculativeDatoms];

    return {
      dbBefore,
      dbAfter,
      txData,
      tempIds: {}, // Empty for now, reserved for future tempid support
    };
  }

  /**
   * Convert DatomsQuery to DatalogQuery, adding viewConfig-specific predicates
   */
  private _datomsQueryToDatalogQuery(
    options: DatomsQuery,
    viewConfig?: DatomDatabaseViewConfig,
  ): DatalogQuery {
    // Use the existing utility function
    const query = datomsQueryToDatalogQuery({...options, viewConfig});

    // Add op predicate if explicitly specified (CTE handles default op=true)
    if (options.op === false || options.op === true) {
      query.where.push({t: '=', left: '?op', right: options.op});
    }

    // Add ordering based on view type
    if (viewConfig?.type === 'history') {
      query.orderBy = [
        {t: 'asc', c: '?tx'},
        {t: 'asc', c: '?e'},
        {t: 'asc', c: '?a'},
      ];
    } else if (!query.orderBy) {
      query.orderBy = [
        {t: 'asc', c: '?e'},
        {t: 'asc', c: '?a'},
      ];
    }

    return query;
  }

  /**
   * Unified query execution method that uses datalogToPostgresSQL for all non-speculative queries
   */
  private async _executeUnifiedQuery(
    options: DatomsQuery,
    viewConfig?: DatomDatabaseViewConfig,
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Convert DatomsQuery to DatalogQuery
    const datalogQuery = this._datomsQueryToDatalogQuery(options, viewConfig);

    // Generate SQL using existing infrastructure
    const {sql, params} = datalogToPostgresSQL(datalogQuery, this.tableName, viewConfig);

    // Execute query and map results
    const rows = await this.sqlDb.query(sql, params);
    return this._mapRowsToDatoms(rows);
  }

  private async _executeSpeculativeQuery(
    options: DatomsQuery,
    speculativeDatoms: Datom[],
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // For speculative queries, fetch base datoms and merge with speculative changes
    const baseDatoms = await this._executeUnifiedQuery({}, {type: 'current'});

    // Create a map of base datoms by (entity, attribute, value) for efficient lookup
    const baseMap = new Map<string, Datom>();
    for (const datom of baseDatoms) {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
      baseMap.set(key, datom);
    }

    // Apply speculative datoms (retractions remove, trues add/update)
    for (const speculativeDatom of speculativeDatoms) {
      const key = `${String(speculativeDatom.e)}|${String(speculativeDatom.a)}|${JSON.stringify(speculativeDatom.v)}`;
      if (speculativeDatom.op === false) {
        baseMap.delete(key);
      } else {
        baseMap.set(key, speculativeDatom);
      }
    }

    // Create merged datoms array
    const mergedDatoms = Array.from(baseMap.values());

    // Apply filters from options
    let results = mergedDatoms;
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
    if (options.op !== undefined) {
      results = results.filter((d) => d.op === options.op);
    } else {
      results = results.filter((d) => d.op === true);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return results.slice(offset, limit ? offset + limit : undefined);
  }

  /**
   * Helper method to map database rows to Datom objects
   */
  private _mapRowsToDatoms(rows: DatabaseRow[]): Datom[] {
    return rows.map((row: DatabaseRow) => {
      const entity: EntityId = String(row.e);

      // PostgreSQL JSONB returns as parsed object, but connection adapter may stringify it
      let parsedValue: unknown = row.v;
      if (typeof row.v === 'string') {
        try {
          parsedValue = JSON.parse(row.v);
        } catch {
          parsedValue = row.v;
        }
      }
      const revivedValue = this._reviveValue(parsedValue) as Value;

      return {
        e: entity,
        a: String(row.a),
        v: revivedValue,
        tx: Number(row.tx),
        op: typeof row.op === 'string' ? row.op === 'true' : Boolean(row.op),
      };
    });
  }

  /**
   * Parse a database row value, handling JSONB parsing and EntityId detection
   */
  private _parseRowValue(
    raw: unknown,
    isEntityId: boolean,
    isFromValueColumn: boolean,
  ): Value | Attribute {
    let value: unknown = raw;
    let wasJsonString = false;

    // Parse JSONB values
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        // Track if the parsed value was originally a JSON string (EntityId)
        if (typeof parsed === 'string') {
          wasJsonString = true;
        }
        value = parsed;
      } catch {
        // Not JSON, keep as string (likely an EntityId)
        wasJsonString = true;
        value = raw;
      }
    } else if (typeof raw === 'number') {
      // Value came as number from PostgreSQL JSONB - was stored as JSON number, not EntityId
      wasJsonString = false;
    }

    // Convert numeric strings to numbers (except EntityIds and values from 'v' column)
    if (!isEntityId && !isFromValueColumn && typeof value === 'string') {
      if (/^-?\d+$/.test(value)) {
        const num = Number.parseInt(value, 10);
        if (!Number.isNaN(num)) {
          value = num;
        }
      } else if (/^-?\d*\.\d+$/.test(value)) {
        const num = Number.parseFloat(value);
        if (!Number.isNaN(num)) {
          value = num;
        }
      }
    }

    // Ensure EntityIds remain as strings
    if (isEntityId) {
      return String(value);
    }

    // For values from 'v' column that are EntityId references (like 'from', 'to'):
    // Convert integers to strings if they were originally JSON strings (EntityIds)
    // This distinguishes EntityIds (stored as JSON strings like "1") from numeric values (stored as JSON numbers like 30)
    // Note: PostgreSQL JSONB may return EntityIds stored as JSON strings as numbers, so we check wasJsonString
    // However, if wasJsonString is false but the value is a small positive integer (< 1000), it might still be an EntityId
    // that PostgreSQL normalized. We convert small integers to be safe, but preserve larger numbers as they're likely numeric values.
    if (
      isFromValueColumn &&
      typeof value === 'number' &&
      Number.isInteger(value) &&
      (wasJsonString || (value >= 0 && value < 1000))
    ) {
      return String(value);
    }

    return this._reviveValue(value) as Value | Attribute;
  }

  private _reviveValue(value: unknown): unknown {
    if (typeof value === 'string' && value === '__UNDEFINED__') {
      return undefined;
    }
    if (value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this._reviveValue(v));
    }
    if (typeof value === 'object') {
      const revived: Record<string, unknown> = {};
      const valueObj = value as Record<string, unknown>;
      for (const key in valueObj) {
        revived[key] = this._reviveValue(valueObj[key]);
      }
      return revived;
    }
    return value;
  }

  async read<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
  ): Promise<QueryResultEnvelope<TFind>> {
    const context = query.context;
    const viewConfig = query.viewConfig ?? {type: 'current'};
    return this._queryWithMetadataInternal(query, context, viewConfig);
  }

  /**
   * Execute datalog query using SQL
   */
  private async _executeDatalogWithSQL(
    query: DatalogQuery,
    viewConfig?: DatomDatabaseViewConfig,
  ): Promise<{results: QueryResult}> {
    const {sql, params} = datalogToPostgresSQL(query, this.tableName, viewConfig);

    const rows = await this.sqlDb.query(sql, params);

    // When we have aggregations only (no GROUP BY), we should get exactly 1 row
    // If we get multiple rows, something is wrong with the SQL
    const findKeys = Object.keys(query.find);
    const hasAggregations = Object.values(query.find).some((e) => e.t !== 'identity');
    if (hasAggregations && rows.length > 1) {
      // Take only the first row - aggregations without GROUP BY should return 1 row
      const firstRow = rows[0];
      if (firstRow) {
        rows.length = 0;
        rows.push(firstRow);
      }
    }

    // Build a map of which output keys come from 'v' column (values that can be EntityIds)
    const keysFromValueColumn = new Set<string>();
    if (findKeys.length > 0) {
      // Build variable mapping to determine which variables come from 'v'
      const variableToColumn = new Map<string, string>();
      for (let i = 0; i < query.where.length; i++) {
        const clause = query.where[i];
        if (clause && isQueryPattern(clause)) {
          const {e: entityVal, a: attributeVal, v: valueVal} = clause;
          const alias = `d${i}_active`;
          if (isVariable(entityVal)) {
            variableToColumn.set(entityVal, `${alias}.e`);
          }
          if (isVariable(attributeVal)) {
            variableToColumn.set(attributeVal, `${alias}.a`);
          }
          if (valueVal !== undefined && isVariable(valueVal)) {
            variableToColumn.set(valueVal as string, `${alias}.v`);
          }
        }
      }

      // Check which find keys map to variables from 'v' column
      // Exclude the standard 'v' field - we only want to mark relationship fields like 'from' and 'to'
      // that are explicitly EntityId references from the 'v' column
      for (const [outputKey, expr] of Object.entries(query.find)) {
        // Skip the standard 'v' field - it can contain both EntityIds and regular values
        if (outputKey === 'v') {
          continue;
        }
        const varName: string | undefined = expr.c;
        if (varName && variableToColumn.get(varName)?.endsWith('.v')) {
          keysFromValueColumn.add(outputKey);
        }
      }
    } else {
      // Empty find clause - check if key corresponds to a variable from 'v'
      for (const clause of query.where) {
        if (clause && isQueryPattern(clause)) {
          const {v: valueVal} = clause;
          if (valueVal !== undefined && isVariable(valueVal)) {
            keysFromValueColumn.add(stripQuestionMark(valueVal as string));
          }
        }
      }
    }

    // Convert SQL results back to QueryResult format
    const results: Record<string, Value | Attribute>[] = rows.map((row: DatabaseRow) => {
      const result: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        const isEntityId = key.toLowerCase() === 'e';
        const isFromValueColumn = keysFromValueColumn.has(key);
        const parsed = this._parseRowValue(row[key], isEntityId, isFromValueColumn);
        result[key] = parsed;
      }
      return result;
    });

    // Map results - they already have output keys as keys (from SQL aliases)
    const finalResults = results.map((row) => {
      const projected: Record<string, Value | Attribute> = {};
      if (findKeys.length === 0) {
        // Empty find clause - return all columns (already have variable names without ? prefix)
        for (const key of Object.keys(row)) {
          projected[key] = row[key];
        }
      } else {
        // Non-empty find clause - only return columns from find
        // Check all keys in row (case-insensitive) to handle PostgreSQL column name variations
        const rowKeys = Object.keys(row);
        for (const outputKey of findKeys) {
          // Try exact match first
          if (outputKey in row) {
            projected[outputKey] = row[outputKey];
          } else {
            // Try case-insensitive match
            const matchingKey = rowKeys.find(
              (key) => key.toLowerCase() === outputKey.toLowerCase(),
            );
            if (matchingKey !== undefined) {
              projected[outputKey] = row[matchingKey];
            } else {
              // Key not found - set to undefined (will be filtered out or handled by caller)
              projected[outputKey] = undefined as unknown as Value | Attribute;
            }
          }
        }
      }
      return projected;
    });
    return {results: finalResults};
  }

  private async _getNextTransactionId(): Promise<{txId: TransactionId}> {
    const sql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      VALUES (1, 0)
      ON CONFLICT (id) 
      DO UPDATE SET last_tx = ${this.tableName}_tx.last_tx + 1
      RETURNING last_tx
    `.trim();

    const result = await this.sqlDb.query(sql);
    if (!result || result.length === 0) {
      throw new Error('Transaction counter row not found after update');
    }
    const row = result[0] as Record<string, unknown>;
    return {txId: Number(row.last_tx)};
  }

  private async _writeDatomsInternal(
    datoms: DatomInput[],
    tx: TransactionId,
    transaction: SQLDatabaseTransaction,
  ): Promise<void> {
    if (datoms.length === 0) return;

    // Batch inserts to avoid PostgreSQL's parameter limit
    const BATCH_SIZE = 199;
    for (let i = 0; i < datoms.length; i += BATCH_SIZE) {
      const batch = datoms.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const sql = `
        INSERT INTO ${this.tableName} (e, a, v, tx, op)
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `.trim();

      const params = batch.flatMap((d) => {
        let value = d.v;
        if (value === undefined) {
          value = '__UNDEFINED__';
        }
        return [String(d.e), String(d.a), JSON.stringify(value), tx, d.op];
      });

      await transaction.query(sql, params);
    }
  }

  async _getLatestTransaction(): Promise<Transaction> {
    await this._ensureInitialized();
    const sql = `SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1`;
    const result = await this.sqlDb.query(sql);
    if (!result || result.length === 0) {
      return {txId: 0, datoms: [], meta: undefined};
    }
    const row = result[0] as Record<string, unknown>;
    const txId = Number(row.last_tx);

    // Get all datoms for this transaction using history view
    const historyResult = await this._executeUnifiedQuery({tx: txId}, {type: 'history'});

    return {
      txId,
      datoms: historyResult,
      meta: undefined,
    };
  }

  async _destroy(config: {retentionCount: number}): Promise<number> {
    await this._ensureInitialized();

    if (config.retentionCount < 1) {
      throw new Error(
        'retentionCount must be at least 1 to ensure at least one datom is kept per (entity, attribute) pair',
      );
    }

    const sql = `
      DELETE FROM ${this.tableName}
      WHERE (e, a, v, tx, op) IN (
        SELECT e, a, v, tx, op
        FROM (
          SELECT 
            e, a, v, tx, op,
            ROW_NUMBER() OVER (PARTITION BY e, a ORDER BY tx DESC) as rn
          FROM ${this.tableName}
        ) ranked
        WHERE rn > ?
      )
      RETURNING 1
    `;

    const params = [config.retentionCount];
    const results = await this.sqlDb.query(sql, params);
    return results.length;
  }

  private async _datomsWithMetadataInternal(
    options: DatomsQuery,
    viewConfig: DatomDatabaseViewConfig,
  ): Promise<{data: Datom[]}> {
    await this._ensureInitialized();

    let result: Datom[];

    if (viewConfig.type === 'speculative') {
      result = await this._executeSpeculativeQuery(options, viewConfig.datoms);
    } else {
      result = await this._executeUnifiedQuery(options, viewConfig);
    }

    return {
      data: result,
    };
  }

  private async _queryWithMetadataInternal<TFind extends Record<string, DatalogQueryFindVariable>>(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
    context: Record<string, unknown> | undefined,
    viewConfig: DatomDatabaseViewConfig,
  ): Promise<QueryResultEnvelope<TFind>> {
    await this._ensureInitialized();

    // Create read context
    const {db: _, query: __, ...restContext} = context || {};
    const enhancedQuery = {
      ...query,
      context: {
        ...restContext,
        db: this,
      },
    };
    const ctx: ReadContext = {
      ...restContext,
      db: this,
      query: enhancedQuery,
    };

    // Run before-read hooks
    const beforeResult = await this.hooks.runBeforeRead(enhancedQuery, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError('Query blocked by hooks', beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query;

    if (modifiedQuery.where.length === 0) {
      return {
        data: [],
      };
    }

    // Validate query has at least one filter or limit
    const hasLimit = modifiedQuery.limit !== undefined;
    const hasMaxResultSize = modifiedQuery.maxResultSize !== undefined;
    let hasFilter = false;
    for (const clause of modifiedQuery.where) {
      if (isQueryPattern(clause)) {
        if (
          !isVariable(clause.e) ||
          !isVariable(clause.a) ||
          (clause.v !== undefined && !isVariable(clause.v)) ||
          (clause.tx !== undefined && !isVariable(clause.tx))
        ) {
          hasFilter = true;
          break;
        }
      }
    }
    // Require at least one filter, limit, or maxResultSize to prevent full table scans
    // Queries with all variables still scan the entire table and need protection
    if (!hasFilter && !hasLimit && !hasMaxResultSize) {
      throw new QuerySafetyError(
        'Query must include at least one filter (entity, attribute, value, tx, txMax), limit, or maxResultSize to prevent full table scans',
      );
    }

    // For speculative views, use in-memory approach
    if (viewConfig.type === 'speculative') {
      // Fetch base datoms and merge with speculative
      // _executeSpeculativeQuery already handles the merge, so we don't need to add viewConfig.datoms again
      const baseDatoms = await this._datomsWithMetadataInternal({}, viewConfig);
      const allDatoms = baseDatoms.data;

      // Execute query using in-memory approach for speculative
      // This is the only place we use in-memory processing
      const patternClauses: DatalogQueryWhereClauseMatch[] = [];
      const predicateClauses: DatalogQueryWhereClause[] = [];
      for (const clause of modifiedQuery.where) {
        if (isQueryPattern(clause)) {
          patternClauses.push(clause);
        } else if (Array.isArray(clause)) {
          predicateClauses.push(clause);
        }
      }

      if (patternClauses.length === 0) {
        return {data: [] as QueryResult<TFind>};
      }

      // Simple in-memory execution for speculative queries
      // Filter datoms by each clause and join results
      let results: Record<string, Value | Attribute>[] = [];

      for (let i = 0; i < patternClauses.length; i++) {
        const clause = patternClauses[i];
        if (!clause) continue;
        const {e: entityVal, a: attributeVal, v: valueVal} = clause;

        // Filter datoms matching this clause
        const clauseResults = allDatoms
          .filter((datom) => {
            if (!isVariable(entityVal) && datom.e !== entityVal) return false;
            if (!isVariable(attributeVal) && datom.a !== attributeVal) return false;
            if (!isVariable(valueVal) && datom.v !== valueVal) return false;
            return true;
          })
          .map((datom) => {
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
            result['?tx'] = datom.tx;
            result['?op'] = datom.op;
            return result;
          });

        if (i === 0) {
          results = clauseResults;
        } else {
          // Join with previous results
          const joined: Record<string, Value | Attribute>[] = [];
          for (const leftRow of results) {
            for (const rightRow of clauseResults) {
              // Check if rows are compatible (same values for common variables)
              let compatible = true;
              for (const key of Object.keys(leftRow)) {
                if (key in rightRow && leftRow[key] !== rightRow[key]) {
                  compatible = false;
                  break;
                }
              }
              if (compatible) {
                joined.push({...leftRow, ...rightRow});
              }
            }
          }
          results = joined;
        }
      }

      // Apply predicate clauses
      for (const predicate of predicateClauses) {
        if (Array.isArray(predicate) && predicate.length === 3) {
          const [op, varName, value] = predicate;
          if (typeof varName === 'string' && varName.startsWith('?')) {
            if (op === '=') {
              results = results.filter((row) => row[varName] === value);
            } else if (op === '<=') {
              results = results.filter((row) => {
                const rowValue = row[varName];
                return rowValue !== undefined && rowValue !== null && rowValue <= value;
              });
            }
          }
        }
      }

      // Project results
      const projected: QueryResult<TFind> = results.map((row) => {
        const result: Record<string, Value | Attribute> = {};
        for (const [outputKey, expr] of Object.entries(modifiedQuery.find)) {
          const varName: string | undefined = expr?.c;
          if (varName && varName in row) {
            result[outputKey] = row[varName] as Value | Attribute;
          }
        }
        return result as QueryResult<TFind>[number];
      }) as QueryResult<TFind>;

      // Apply ordering
      if (modifiedQuery.orderBy) {
        projected.sort((a, b) => {
          for (const orderBy of modifiedQuery.orderBy ?? []) {
            const {c: variable, t: direction} = orderBy;
            const key = stripQuestionMark(variable);
            const aVal = a[key];
            const bVal = b[key];
            if (aVal == null && bVal == null) continue;
            if (aVal == null) return direction === 'asc' ? -1 : 1;
            if (bVal == null) return direction === 'asc' ? 1 : -1;
            if (aVal < bVal) return direction === 'asc' ? -1 : 1;
            if (aVal > bVal) return direction === 'asc' ? 1 : -1;
          }
          return 0;
        });
      }

      // Apply limit
      const finalResult = modifiedQuery.limit ? projected.slice(0, modifiedQuery.limit) : projected;

      // Check maxResultSize
      if (modifiedQuery.maxResultSize !== undefined) {
        if (finalResult.length > modifiedQuery.maxResultSize) {
          throw new QueryResultSizeError(
            finalResult.length,
            modifiedQuery.maxResultSize,
            modifiedQuery,
          );
        }
      }

      // Run after-read hooks
      const afterResult = await this.hooks.runAfterRead(finalResult, ctx);

      if (afterResult.errors.length > 0) {
        throw new QueryError('Query blocked by after-read hooks', afterResult.errors);
      }

      return {
        data: afterResult.results,
      };
    }

    // For non-speculative views, always use SQL execution
    const sqlResult = await this._executeDatalogWithSQL(modifiedQuery, viewConfig);
    let finalResult = sqlResult.results as QueryResult<TFind>;

    // Apply ordering if specified (SQL may not handle all cases)
    if (modifiedQuery.orderBy && finalResult.length > 0) {
      finalResult.sort((a, b) => {
        for (const orderBy of modifiedQuery.orderBy ?? []) {
          const {c: variable, t: direction} = orderBy;
          const outputKey =
            Object.keys(modifiedQuery.find).find((key) => {
              const expr = modifiedQuery.find[key];
              if (typeof expr === 'string') {
                return expr === variable;
              }
              if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
                return expr[0] === variable;
              }
              return false;
            }) || stripQuestionMark(variable);
          const aVal = a[outputKey];
          const bVal = b[outputKey];
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === 'asc' ? -1 : 1;
          if (bVal == null) return direction === 'asc' ? 1 : -1;
          if (aVal < bVal) return direction === 'asc' ? -1 : 1;
          if (aVal > bVal) return direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }

    // Apply limit if specified (SQL may not handle all cases)
    if (modifiedQuery.limit) {
      finalResult = finalResult.slice(0, modifiedQuery.limit) as QueryResult<TFind>;
    }

    // Check maxResultSize
    if (modifiedQuery.maxResultSize !== undefined) {
      if (finalResult.length > modifiedQuery.maxResultSize) {
        throw new QueryResultSizeError(
          finalResult.length,
          modifiedQuery.maxResultSize,
          modifiedQuery,
        );
      }
    }

    // Run after-read hooks
    const afterResult = await this.hooks.runAfterRead(finalResult, ctx);

    if (afterResult.errors.length > 0) {
      throw new QueryError('Query blocked by after-read hooks', afterResult.errors);
    }

    return {
      data: afterResult.results,
    };
  }
}
