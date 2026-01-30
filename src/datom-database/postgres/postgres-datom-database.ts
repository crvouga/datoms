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
  type DatalogQueryOrderByClause,
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
import type {DatomsQuery} from '../../datoms-query.js';
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

  constructor({
    sqlDb,
    tableName = 'datoms',
  }: {
    sqlDb: SQLDatabase;
    tableName?: string;
  }) {
    this.hooks = new HookEngine();
    this.sqlDb = sqlDb;
    this.tableName = tableName || 'datoms';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.sqlDb.transaction(async tx => {
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

    await this.sqlDb.transaction(async transaction => {
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
    const allFinalDatoms = finalTx.datoms.map(d => ({
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
      datoms: finalTx.datoms.map(d => ({...d, tx: committedTxId})),
      timestamp: Date.now(),
    };

    // Run after-write hooks (fire and forget)
    this.hooks.runAfterWrite(writeResult, ctx).catch(err => {
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
   * Convert DatomsQuery options to DatalogQuery format for unified SQL generation
   */
  private _datomsQueryToDatalogQuery(
    options: DatomsQuery,
    viewConfig?: DatomDatabaseViewConfig,
  ): DatalogQuery {
    // Validate mutually exclusive parameters
    if (options.tx !== undefined && options.txMax !== undefined) {
      throw new Error('Cannot specify both tx and txMax parameters - they are mutually exclusive');
    }

    // Build QueryPattern based on provided filters
    const pattern: DatalogQueryWhereClauseMatch = {
      t: 'match',
      e: options.e !== undefined ? options.e : '?e',
      a: options.a !== undefined ? options.a : '?a',
      v: options.v !== undefined ? options.v : '?v',
    };

    // Build WHERE clause predicates for tx/txMax/op filters
    const where: DatalogQueryWhereClause[] = [pattern];

    // Handle tx/txMax filtering
    // For asOf queries, _buildWhereConditions already adds tx <= viewConfig.txId
    // We only add predicates if user's constraints are more restrictive
    if (viewConfig?.type === 'asOf') {
      // For asOf, viewConfig.txId is already applied as upper bound
      // Add user's tx/txMax only if more restrictive
      if (options.tx !== undefined) {
        // If user specifies exact tx, use it (it will be ANDed with tx <= viewConfig.txId)
        where.push(['=', '?tx' as const, options.tx] as unknown as DatalogQueryWhereClause);
      } else if (options.txMax !== undefined && options.txMax < viewConfig.txId) {
        // If user's txMax is more restrictive, add it
        where.push(['<=', '?tx' as const, options.txMax] as unknown as DatalogQueryWhereClause);
      }
      // Otherwise, rely on viewConfig.txId from _buildWhereConditions
    } else {
      // For non-asOf queries, use options directly
      if (options.tx !== undefined) {
        where.push(['=', '?tx' as const, options.tx] as unknown as DatalogQueryWhereClause);
      }
      if (options.txMax !== undefined) {
        where.push(['<=', '?tx' as const, options.txMax] as unknown as DatalogQueryWhereClause);
      }
    }

    // Handle op filtering: if undefined or true, default to true (handled by CTE)
    // If explicitly false, add predicate to filter to false
    // If explicitly true, we can add predicate or rely on CTE default
    if (options.op === false) {
      where.push(['=', '?op' as const, false] as unknown as DatalogQueryWhereClause);
    } else if (options.op === true) {
      // Explicitly true - can add predicate or rely on CTE default (CTE default is fine)
      // Adding predicate ensures consistency
      where.push(['=', '?op' as const, true] as unknown as DatalogQueryWhereClause);
    }
    // If undefined, rely on CTE default (op = true for non-history queries)

    // Build find clause to return raw datom fields
    const find: Record<string, DatalogQueryFindVariable> = {
      e: {t: 'identity' as const, c: '?e' as const},
      a: {t: 'identity' as const, c: '?a' as const},
      v: {t: 'identity' as const, c: '?v' as const},
      tx: {t: 'identity' as const, c: '?tx' as const},
      op: {t: 'identity' as const, c: '?op' as const},
    };

    // Set default ordering based on view type
    // History queries: order by tx, e, a
    // Other queries: order by numeric e, then a (handled by SQL CASE expression)
    // Note: The actual SQL ordering with CASE for numeric e is handled in datalog-to-postgres-sql.ts
    // via the CTE structure, but we add explicit ordering here for consistency
    let orderBy: DatalogQueryOrderByClause[] | undefined;
    if (viewConfig?.type === 'history') {
      orderBy = [
        {t: 'asc', c: '?tx' as const},
        {t: 'asc', c: '?e' as const},
        {t: 'asc', c: '?a' as const},
      ];
    } else {
      // For other queries, we rely on the CTE's internal ordering
      // The final result ordering is handled by the SQL CASE expression in the CTE
      // But we can add basic ordering here
      orderBy = [
        {t: 'asc', c: '?e' as const},
        {t: 'asc', c: '?a' as const},
      ];
    }

    return {
      find,
      where,
      orderBy,
      limit: options.limit,
      offset: options.offset,
    };
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
      results = results.filter(d => d.e === options.e);
    }
    if (options.a !== undefined) {
      results = results.filter(d => d.a === options.a);
    }
    if (options.v !== undefined) {
      results = results.filter(d => d.v === options.v);
    }
    if (options.tx !== undefined) {
      results = results.filter(d => d.tx === options.tx);
    }
    if (options.op !== undefined) {
      results = results.filter(d => d.op === options.op);
    } else {
      results = results.filter(d => d.op === true);
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

  private _reviveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value === '__UNDEFINED__') {
        return undefined;
      }
    }
    if (value === null) {
      return null;
    }
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map(v => this._reviveValue(v));
    }
    if (typeof value === 'object' && value !== null) {
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
    const hasAggregations = Object.values(query.find).some(e => e.t !== 'identity');
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
        if (clause && typeof clause === 'object' && 't' in clause && clause.t === 'match') {
          const {e: entityVal, a: attributeVal, v: valueVal} = clause;
          const alias = `d${i}_active`;
          if (typeof entityVal === 'string' && entityVal.startsWith('?')) {
            variableToColumn.set(entityVal, `${alias}.e`);
          }
          if (typeof attributeVal === 'string' && attributeVal.startsWith('?')) {
            variableToColumn.set(attributeVal, `${alias}.a`);
          }
          if (typeof valueVal === 'string' && valueVal.startsWith('?')) {
            variableToColumn.set(valueVal, `${alias}.v`);
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
        if (clause && typeof clause === 'object' && 't' in clause && clause.t === 'match') {
          const {v: valueVal} = clause;
          if (typeof valueVal === 'string' && valueVal.startsWith('?')) {
            const keyName = valueVal.slice(1); // Remove '?' prefix
            keysFromValueColumn.add(keyName);
          }
        }
      }
    }

    // Convert SQL results back to QueryResult format
    const results: Record<string, Value | Attribute>[] = rows.map((row: DatabaseRow) => {
      const result: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        let value: unknown = row[key];
        // Entity IDs ('e' field) and values from 'v' column must remain as strings
        // Values from 'v' can be EntityIds, so we preserve them as strings to be safe
        const isEntityId = key.toLowerCase() === 'e';
        const isFromValueColumn = keysFromValueColumn.has(key);

        // Track if value was originally a JSON string (EntityId) vs JSON number
        let wasJsonString = false;

        // PostgreSQL stores values as JSONB, so parse them
        if (typeof value === 'string') {
          // For values from 'v' column that are numeric strings, check if they were JSON strings
          if (isFromValueColumn && /^-?\d+$/.test(value)) {
            // This is a numeric string from 'v' column - could be an EntityId
            // Check if it's a JSON string (like "1") vs JSON number (like 1)
            // If JSON.parse returns a string, it was definitely a JSON string (EntityId)
            // If JSON.parse returns a number, it was a JSON number (regular numeric value)
            try {
              const parsed = JSON.parse(value);
              if (typeof parsed === 'string') {
                // It was a JSON string (EntityId like "1")
                value = parsed;
                wasJsonString = true;
              } else {
                // It was a JSON number (like 30)
                value = parsed;
                wasJsonString = false;
              }
            } catch {
              // Not valid JSON, treat as plain string (might be EntityId)
              wasJsonString = true;
            }
          } else if (!isEntityId && !isFromValueColumn && /^-?\d+$/.test(value)) {
            // Not from 'v' column and not entity ID - safe to convert to number
            const num = Number.parseInt(value, 10);
            if (!Number.isNaN(num)) {
              value = num;
            } else {
              try {
                value = JSON.parse(value);
                wasJsonString = typeof value === 'string';
              } catch {
                // Not valid JSON, keep as string
                wasJsonString = true;
              }
            }
          } else {
            // Try JSON parsing for other cases
            try {
              const parsed = JSON.parse(value);
              value = parsed;
              wasJsonString = typeof parsed === 'string';
            } catch {
              // Not valid JSON, keep as string
              wasJsonString = true;
            }
          }
        } else if (typeof value === 'number') {
          // Value came as number from database - definitely not a string EntityId
          // Keep it as a number (was stored as JSON number)
          wasJsonString = false;
        } else {
          // For other types (boolean, object, etc.), not a string EntityId
          wasJsonString = false;
        }
        // For aggregation results, handle numeric strings specially (but not entity IDs or values from 'v')
        let finalValue = value;
        if (!isEntityId && !isFromValueColumn && typeof value === 'string') {
          if (/^-?\d+$/.test(value)) {
            const num = Number.parseInt(value, 10);
            if (!Number.isNaN(num)) {
              finalValue = num;
            }
          } else if (/^-?\d*\.\d+$/.test(value)) {
            const num = Number.parseFloat(value);
            if (!Number.isNaN(num)) {
              finalValue = num;
            }
          }
        }
        // Ensure entity IDs remain as strings
        if (isEntityId) {
          if (typeof finalValue === 'number') {
            finalValue = String(finalValue);
          } else if (typeof finalValue !== 'string') {
            finalValue = String(finalValue);
          }
        }
        // For values from 'v' column (excluding the standard 'v' field):
        // Convert to string if it was originally a JSON string (EntityId)
        // Also check field name as fallback - fields like 'from', 'to' are typically EntityIds
        // If it was stored as a JSON number (like age: 30), keep it as a number
        // This preserves EntityIds (stored as JSON strings) while keeping numeric values as numbers
        // Check if field name suggests it's an EntityId reference
        // Common patterns: from, to, parent, child, entityId, or fields ending in Id/_id
        // Also check for relationship-related words like friend, owner, author, etc.
        // Exclude fields that end in 'Name' as those are typically string values, not EntityIds
        const isLikelyEntityIdField =
          (key === 'from' ||
            key === 'to' ||
            key === 'parent' ||
            key === 'child' ||
            key === 'entityId' ||
            key.endsWith('Id') ||
            key.endsWith('_id') ||
            (key.includes('friend') && !key.endsWith('Name')) ||
            (key.includes('owner') && !key.endsWith('Name')) ||
            (key.includes('author') && !key.endsWith('Name')) ||
            (key.includes('user') && !key.endsWith('Name'))) &&
          !key.endsWith('Name');
        if (
          isFromValueColumn &&
          typeof finalValue === 'number' &&
          Number.isInteger(finalValue) &&
          (wasJsonString || isLikelyEntityIdField)
        ) {
          // It was stored as a JSON string EntityId (like "1") but JSON.parse converted it to number
          // Or it's a field that's typically an EntityId reference
          // Convert back to string since EntityIds are always strings
          finalValue = String(finalValue);
        }
        result[key] = this._reviveValue(finalValue) as Value | Attribute;
      }
      return result;
    });

    // Map results - they already have output keys as keys (from SQL aliases)
    const finalResults = results.map(row => {
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
            const matchingKey = rowKeys.find(key => key.toLowerCase() === outputKey.toLowerCase());
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

      const params = batch.flatMap(d => {
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
      const patternClauses: DatalogQueryWhereClause[] = [];
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
        if (!clause || !isQueryPattern(clause)) {
          continue;
        }
        const {e: entityVal, a: attributeVal, v: valueVal} = clause;

        // Filter datoms matching this clause
        const clauseResults = allDatoms
          .filter(datom => {
            if (!isVariable(entityVal) && datom.e !== entityVal) return false;
            if (!isVariable(attributeVal) && datom.a !== attributeVal) return false;
            if (!isVariable(valueVal) && datom.v !== valueVal) return false;
            return true;
          })
          .map(datom => {
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
          if (op === '=' && typeof varName === 'string' && varName.startsWith('?')) {
            results = results.filter(row => row[varName] === value);
          } else if (op === '<=' && typeof varName === 'string' && varName.startsWith('?')) {
            results = results.filter(row => {
              const rowValue = row[varName];
              return rowValue !== undefined && rowValue !== null && rowValue <= value;
            });
          }
        }
      }

      // Project results
      const projected: QueryResult<TFind> = results.map(row => {
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
            Object.keys(modifiedQuery.find).find(key => {
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
