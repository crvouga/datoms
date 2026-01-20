/**
 * SQLite database implementation
 * Accepts a SqlConnection interface for SQLite-compatible databases
 */

import type {DatalogQuery, DatalogQueryFindVariable} from '../../datalog/datalog.js';
import type {Attribute, Datom, DatomInput, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {SQLDatabase} from '../../sql-database/sql-database.js';
import type {Transaction} from '../../types.js';
import type {DatomDatabase, WithResult} from '../datom-database.js';
import {
  HookEngine,
  QueryError,
  QueryResultSizeError,
  QuerySafetyError,
  QueryTimeoutError,
  TransactionError,
  type Hook,
  type ReadContext,
  type WriteContext,
  type WriteResult,
} from '../hook/hook.js';
import {isQueryPattern, isVariable, stripQuestionMark} from '../shared/datalog-helpers.js';
import {executeQueryOnDatoms} from '../shared/in-memory-query-executor.js';
import {joinResults, project} from '../shared/query-results.js';
import {ConfiguredDatabaseView} from '../views/configured-database-view.js';
import type {
  DatabaseView,
  DatomsQuery,
  DatomsResultEnvelope,
  QueryResult,
  QueryResultEnvelope,
} from '../views/database-view.js';
import type {ViewConfig} from '../views/view-config.js';

/**
 * SQLite database implementation
 * Accepts a SqlDatabase that implements SQLite-compatible SQL
 */
export class SQLiteDatomDatabase implements DatomDatabase {
  public readonly hooks: HookEngine;
  protected initialized = false;
  private connection: SQLDatabase;
  private tableName: string;

  constructor(connection: SQLDatabase, tableName = 'datoms') {
    this.hooks = new HookEngine();
    this.connection = connection;
    this.tableName = tableName;
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          e TEXT NOT NULL,
          a TEXT NOT NULL,
          v TEXT NOT NULL,
          tx INTEGER NOT NULL,
          op BOOLEAN NOT NULL,
          PRIMARY KEY (e, a, v, tx, op)
        )
      `;

      // Optimized composite indexes for common query patterns
      const indexes = [
        // Composite index for entity+attribute queries (most common pattern)
        // SQLite doesn't support DESC in index definition, but this helps with filtering
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e_a_tx ON ${this.tableName}(e, a, tx)`,
        // Composite index for attribute+value queries
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_v_tx ON ${this.tableName}(a, v, tx)`,
        // Index on tx for transaction-based queries (DESC ordering handled in query)
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx)`,
        // Covering index for entity lookups
        `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e ON ${this.tableName}(e)`,
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

  hook(hook: Hook): void {
    this.hooks.register(hook);
  }

  private async _writeDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const tx = await this._getNextTransactionId();
    await this._writeDatomsInternal(datoms, tx);
    return tx;
  }

  async transact(
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

    // Process operations sequentially
    const adds: DatomInput[] = [];
    const subs: DatomInput[] = [];

    for (const op of ops.flat()) {
      const datom = {e: op.e, a: op.a, v: op.v, op: op.op};

      if (op.op === true) {
        // Validate add, accounting for subs already processed
        await this._validateDatoms([datom], true, subs);
        adds.push(datom);
      } else {
        // Validate sub
        await this._validateDatoms([datom], false);
        subs.push(datom);
      }
    }

    // Convert to datoms for transaction object
    const allDatoms: Datom[] = [];
    const latestTx = await this._getLatestTransaction();
    // biome-ignore lint/style/noNonNullAssertion: latestTx.txId is guaranteed to exist for latest transaction
    const txId = latestTx.txId! + 1;

    for (const sub of subs) {
      allDatoms.push({
        e: sub.e,
        a: sub.a,
        v: sub.v,
        tx: txId,
        op: false,
      });
    }

    for (const add of adds) {
      allDatoms.push({
        e: add.e,
        a: add.a,
        v: add.v,
        tx: txId,
        op: true,
      });
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

    // Combine all datoms from the modified transaction (using the modified transaction from hooks)
    const finalTx = beforeResult.tx;
    const allFinalDatoms = finalTx.datoms.map(d => ({
      e: d.e,
      a: d.a,
      v: d.v,
      op: d.op,
    }));

    // Write all datoms (both adds and subs) in a single call
    // If there are no operations, still create a new transaction ID
    const committedTxId = await this._writeDatoms(allFinalDatoms);

    // Create write result for after-write hooks
    const writeResult: WriteResult = {
      txId: committedTxId,
      datoms: finalTx.datoms.map(d => ({...d, tx: committedTxId})),
      timestamp: Date.now(),
    };

    // Run after-write hooks (fire and forget, don't block)
    this.hooks.runAfterWrite(writeResult, ctx).catch(err => {
      console.error('After-write hook failed:', err);
    });

    return committedTxId;
  }

  private async _validateDatoms(
    datoms: DatomInput[],
    _isAdd: boolean,
    _subsInSameTransaction?: DatomInput[],
  ): Promise<void> {
    // Basic runtime validation for cases where TypeScript types are bypassed
    for (const datom of datoms) {
      if (datom.e === null || datom.e === undefined) {
        throw new Error('Datom must have an entity ID');
      }
      if (datom.a === null || datom.a === undefined) {
        throw new Error('Datom must have an attribute');
      }
    }
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async datoms(options: DatomsQuery): Promise<DatomsResultEnvelope> {
    // Validate that tx and txMax are mutually exclusive
    if (options.tx !== undefined && options.txMax !== undefined) {
      throw new Error('Cannot specify both tx and txMax parameters - they are mutually exclusive');
    }

    // Validate that query has at least one filter or limit to prevent accidental full scans
    const hasFilter =
      options.e !== undefined ||
      options.a !== undefined ||
      options.v !== undefined ||
      options.tx !== undefined ||
      options.txMax !== undefined;
    const hasLimit = options.limit !== undefined;

    if (!hasFilter && !hasLimit) {
      throw new QuerySafetyError(
        'Query must include at least one filter (entity, attribute, value, tx, txMax) or a limit to prevent full table scans',
      );
    }

    // Extract viewConfig from options
    const viewConfig = options.viewConfig ?? {type: 'current'};

    // Execute query with timeout if specified
    let envelope: DatomsResultEnvelope;
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          // biome-ignore lint/style/noNonNullAssertion: timeoutMs is required when timeoutPromise is created
          reject(new QueryTimeoutError(options.timeoutMs!, options));
        }, options.timeoutMs);
      });

      const queryPromise = this._datomsWithMetadataInternal(options, viewConfig);
      envelope = await Promise.race([queryPromise, timeoutPromise]);
    } else {
      envelope = await this._datomsWithMetadataInternal(options, viewConfig);
    }

    // Check result size limit if specified
    if (options.maxResultSize !== undefined && envelope.data.length > options.maxResultSize) {
      throw new QueryResultSizeError(envelope.data.length, options.maxResultSize, options);
    }

    return envelope;
  }

  asOf(txId: TransactionId): DatabaseView {
    return new ConfiguredDatabaseView(this, {type: 'asOf', txId});
  }

  history(): DatabaseView {
    return new ConfiguredDatabaseView(this, {type: 'history'});
  }

  since(txId: TransactionId): DatabaseView {
    return new ConfiguredDatabaseView(this, {type: 'since', txId});
  }

  async with(ops: DatomInput[]): Promise<WithResult> {
    await this._ensureInitialized();

    // Get the next transaction ID for speculative datoms
    const speculativeTxId = (await this._getLatestTransaction()).txId + 1;

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
    const dbBefore = new ConfiguredDatabaseView(this, {type: 'current'});

    // Create dbAfter view (speculative state)
    const dbAfter = new ConfiguredDatabaseView(this, {
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

  private async _executeCurrentQuery(options: DatomsQuery): Promise<Datom[]> {
    await this._ensureInitialized();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.e !== undefined) {
      conditions.push('e = ?');
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push('a = ?');
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      conditions.push('v = ?');
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push('tx = ?');
      params.push(options.tx);
    }
    if (options.txMax !== undefined) {
      conditions.push('tx <= ?');
      params.push(options.txMax);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Use SQL-level deduplication with ROW_NUMBER() window function
    // Deduplicate by (e, a, v) to support multi-valued attributes
    const partitionByColumns = 'e, a, v';

    // Build the op filter
    let opFilter = '';
    if (options.op === undefined || options.op === true) {
      opFilter = 'AND op = true';
    } else if (options.op === false) {
      opFilter = 'AND op = false';
    }

    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          e,
          a,
          v,
          tx,
          op,
          ROW_NUMBER() OVER (
            PARTITION BY ${partitionByColumns}
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ranked_datoms
      WHERE rn = 1
      ${opFilter}
      ORDER BY
        CASE 
          WHEN e GLOB '-[0-9]*' OR e GLOB '[0-9]*' THEN CAST(e AS INTEGER)
          ELSE 0
        END,
        a
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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeAsOfQuery(options: DatomsQuery, txId: TransactionId): Promise<Datom[]> {
    await this._ensureInitialized();

    // Validate that tx and txMax are mutually exclusive
    if (options.tx !== undefined && options.txMax !== undefined) {
      throw new Error('Cannot specify both tx and txMax parameters - they are mutually exclusive');
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions
    if (options.e !== undefined) {
      conditions.push('e = ?');
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push('a = ?');
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      conditions.push('v = ?');
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      params.push(JSON.stringify(value));
    }

    // Merge options.tx or options.txMax with txId: use minimum of both
    let maxTx = txId;
    if (options.tx !== undefined) {
      maxTx = Math.min(options.tx, txId);
    } else if (options.txMax !== undefined) {
      maxTx = Math.min(options.txMax, txId);
    }
    conditions.push('tx <= ?');
    params.push(maxTx);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    // Use ROW_NUMBER() OVER to deduplicate by (e, a)
    // This keeps the latest value per attribute (asOf semantics)
    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          e,
          a,
          v,
          tx,
          op,
          ROW_NUMBER() OVER (
            PARTITION BY e, a
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ranked_datoms
      WHERE rn = 1 AND op = true
      ORDER BY
        CASE 
          WHEN e GLOB '-[0-9]*' OR e GLOB '[0-9]*' THEN CAST(e AS INTEGER)
          ELSE 0
        END,
        a
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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeHistoryQuery(options: DatomsQuery): Promise<Datom[]> {
    await this._ensureInitialized();

    // Validate that tx and txMax are mutually exclusive
    if (options.tx !== undefined && options.txMax !== undefined) {
      throw new Error('Cannot specify both tx and txMax parameters - they are mutually exclusive');
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions
    if (options.e !== undefined) {
      conditions.push('e = ?');
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push('a = ?');
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      conditions.push('v = ?');
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      params.push(JSON.stringify(value));
    }
    if (options.tx !== undefined) {
      conditions.push('tx = ?');
      params.push(options.tx);
    }
    if (options.txMax !== undefined) {
      conditions.push('tx <= ?');
      params.push(options.txMax);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    // History query: no deduplication, include all datoms including sub
    const sql = `
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY tx ASC, e ASC, a ASC
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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeSinceQuery(options: DatomsQuery, txId: TransactionId): Promise<Datom[]> {
    await this._ensureInitialized();

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions
    if (options.e !== undefined) {
      conditions.push('e = ?');
      params.push(String(options.e));
    }
    if (options.a !== undefined) {
      conditions.push('a = ?');
      params.push(String(options.a));
    }
    if (options.v !== undefined) {
      conditions.push('v = ?');
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      params.push(JSON.stringify(value));
    }

    // Filter to only datoms with tx > txId
    conditions.push('tx > ?');
    params.push(txId);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    // Use ROW_NUMBER() OVER to deduplicate by (e, a, v)
    const sql = `
      WITH ranked_datoms AS (
        SELECT 
          e,
          a,
          v,
          tx,
          op,
          ROW_NUMBER() OVER (
            PARTITION BY e, a, v
            ORDER BY tx DESC
          ) AS rn
        FROM ${this.tableName}
        ${whereClause}
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM ranked_datoms
      WHERE rn = 1 AND op = true
      ORDER BY
        CASE 
          WHEN e GLOB '-[0-9]*' OR e GLOB '[0-9]*' THEN CAST(e AS INTEGER)
          ELSE 0
        END,
        a
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
    return this._mapRowsToDatoms(rows);
  }

  private async _executeSpeculativeQuery(
    options: DatomsQuery,
    speculativeDatoms: Datom[],
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // Get all base datoms using _executeCurrentQuery with a large limit
    // This gets current datoms (already deduplicated and filtered to op=true)
    const allBaseDatoms = await this._executeCurrentQuery({limit: Number.MAX_SAFE_INTEGER});

    // Create a map of base datoms by (entity, attribute, value) for efficient lookup
    const baseMap = new Map<string, Datom>();
    for (const datom of allBaseDatoms) {
      const key = `${String(datom.e)}|${String(datom.a)}|${JSON.stringify(datom.v)}`;
      baseMap.set(key, datom);
    }

    // Apply speculative datoms (falses remove, trues add/update)
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

    // Use the shared query execution logic
    return executeQueryOnDatoms(mergedDatoms, options);
  }

  /**
   * Helper method to map database rows to Datom objects
   * Reused across query methods
   */
  private _mapRowsToDatoms(rows: Record<string, unknown>[]): Datom[] {
    return rows.map((row: Record<string, unknown>) => {
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === 'string') {
        if (/^-?\d+$/.test(entity)) {
          entity = Number.parseInt(entity, 10);
        }
      }

      const parsedValue: unknown = JSON.parse(String(row.v));
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

  async query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
  ): Promise<QueryResultEnvelope<TFind>> {
    // Extract context and viewConfig from query object
    const context = query.context;
    const viewConfig = query.viewConfig ?? {type: 'current'};
    return this._queryWithMetadataInternal(query, context, viewConfig);
  }

  /**
   * Extract all datoms that match a query (before projection)
   */
  private async _extractDatomsFromQuery(query: DatalogQuery): Promise<Datom[]> {
    const allDatomsSet = new Set<string>();
    const allDatoms: Datom[] = [];

    for (const clause of query.where) {
      if (!isQueryPattern(clause)) {
        continue;
      }
      const {e: entityVal, a: attributeVal, v: valueVal} = clause;
      const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
      const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const clauseDatoms = await this._executeCurrentQuery({
        e: entity,
        a: attribute,
        v: value,
        op: true,
      });

      for (const datom of clauseDatoms) {
        const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
        if (!allDatomsSet.has(key)) {
          allDatomsSet.add(key);
          allDatoms.push(datom);
        }
      }
    }

    return allDatoms;
  }

  /**
   * Execute datalog query with filtered datoms from hooks
   * Uses datom-level execution to properly support afterRead hooks
   */
  private async _executeDatalogWithSQLAndFilteredDatoms(
    query: DatalogQuery,
    filteredDatoms: Datom[],
  ): Promise<QueryResult> {
    // Create a set of allowed datoms for filtering
    const allowedDatomsSet = new Set<string>();
    for (const datom of filteredDatoms) {
      const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
      allowedDatomsSet.add(key);
    }

    // Execute query at datom level using filtered datoms
    if (query.where.length === 0) {
      return [];
    }

    // Execute first clause using filtered datoms
    const firstClause = query.where[0];
    if (!firstClause || !isQueryPattern(firstClause)) {
      throw new Error('First clause must be a QueryPattern');
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = firstClause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Filter datoms for first clause
    let firstDatoms = filteredDatoms;
    if (entity !== undefined) {
      firstDatoms = firstDatoms.filter(d => d.e === entity);
    }
    if (attribute !== undefined) {
      firstDatoms = firstDatoms.filter(d => d.a === attribute);
    }
    if (value !== undefined) {
      firstDatoms = firstDatoms.filter(d => JSON.stringify(d.v) === JSON.stringify(value));
    }

    const firstResults = firstDatoms.map(datom => {
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

    // Join with remaining clauses
    let results = firstResults;
    for (let i = 1; i < query.where.length; i++) {
      const clause = query.where[i];
      if (!clause || !isQueryPattern(clause)) {
        throw new Error('Only QueryPattern clauses are supported in joins');
      }
      const {e: entityVal, a: attributeVal, v: valueVal} = clause;
      const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
      const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      // Filter datoms for this clause
      let clauseDatoms = filteredDatoms;
      if (entity !== undefined) {
        clauseDatoms = clauseDatoms.filter(d => d.e === entity);
      }
      if (attribute !== undefined) {
        clauseDatoms = clauseDatoms.filter(d => d.a === attribute);
      }
      if (value !== undefined) {
        clauseDatoms = clauseDatoms.filter(d => JSON.stringify(d.v) === JSON.stringify(value));
      }

      const clauseResults = clauseDatoms.map(datom => {
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

      results = joinResults(results, clauseResults, query.where.slice(0, i + 1));
    }

    // Project to find variables
    const projected = project(results, query.find, query.where);

    // Apply ordering if specified
    if (query.orderBy) {
      // Map orderBy variables to output keys from find clause
      const variableToOutputKey = new Map<string, string>();
      for (const [outputKey, expr] of Object.entries(query.find)) {
        let varName: string | undefined;
        if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
          varName = expr[0];
        } else if (typeof expr === 'string') {
          varName = expr;
        }
        if (varName) {
          variableToOutputKey.set(varName, outputKey);
        }
      }

      projected.sort(
        (a: Record<string, Value | Attribute>, b: Record<string, Value | Attribute>) => {
          for (const [variable, direction] of query.orderBy ?? []) {
            // Map variable to output key, or fall back to stripped variable name
            const outputKey = variableToOutputKey.get(variable) ?? stripQuestionMark(variable);
            const aVal = a[outputKey];
            const bVal = b[outputKey];
            // Handle null/undefined
            if (aVal == null && bVal == null) continue;
            if (aVal == null) return direction === 'asc' ? -1 : 1;
            if (bVal == null) return direction === 'asc' ? 1 : -1;

            // Ensure proper numeric comparison when both values are numeric
            let comparison: number;
            const aIsNumber = typeof aVal === 'number';
            const bIsNumber = typeof bVal === 'number';

            let aNum: number | null = null;
            let bNum: number | null = null;

            if (aIsNumber) {
              aNum = aVal;
            } else if (typeof aVal === 'string' && aVal !== '') {
              const parsed = Number(aVal);
              if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
                aNum = parsed;
              }
            }

            if (bIsNumber) {
              bNum = bVal;
            } else if (typeof bVal === 'string' && bVal !== '') {
              const parsed = Number(bVal);
              if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
                bNum = parsed;
              }
            }

            // If both are numeric, compare as numbers
            if (aNum !== null && bNum !== null) {
              comparison = aNum - bNum;
            } else {
              // At least one is not numeric, use locale-aware string comparison
              // Convert to strings to ensure consistent comparison (matching test expectations)
              const aStr = String(aVal);
              const bStr = String(bVal);
              comparison = aStr.localeCompare(bStr);
            }

            if (comparison !== 0) {
              return direction === 'asc' ? comparison : -comparison;
            }
          }
          return 0;
        },
      );
    }

    // Apply limit if specified
    if (query.limit !== undefined) {
      return projected.slice(0, query.limit);
    }

    return projected;
  }

  private _reviveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value === '__UNDEFINED__') {
        return undefined;
      }
      // Try parsing as JSON if it looks like JSON
      if ((value.startsWith('{') || value.startsWith('[')) && value.length > 1) {
        try {
          const parsed: unknown = JSON.parse(value);
          return this._reviveValue(parsed);
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

  private _applyOrderAndLimit(results: QueryResult, query: DatalogQuery): QueryResult {
    if (query.orderBy) {
      // Map orderBy variables to output keys from find clause
      const variableToOutputKey = new Map<string, string>();
      for (const [outputKey, expr] of Object.entries(query.find)) {
        let varName: string | undefined;
        if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
          varName = expr[0];
        } else if (typeof expr === 'string') {
          varName = expr;
        }
        if (varName) {
          variableToOutputKey.set(varName, outputKey);
        }
      }

      results.sort((a, b) => {
        // biome-ignore lint/style/noNonNullAssertion: orderBy is guaranteed to exist when sorting
        for (const [variable, direction] of query.orderBy!) {
          // Map variable to output key, or fall back to stripped variable name
          const outputKey = variableToOutputKey.get(variable) ?? stripQuestionMark(variable);
          const aVal = a[outputKey];
          const bVal = b[outputKey];

          // Handle null/undefined
          if (aVal == null && bVal == null) continue;
          if (aVal == null) return direction === 'asc' ? -1 : 1;
          if (bVal == null) return direction === 'asc' ? 1 : -1;

          // Ensure proper numeric comparison when both values are numeric
          let comparison: number;
          const aIsNumber = typeof aVal === 'number';
          const bIsNumber = typeof bVal === 'number';

          let aNum: number | null = null;
          let bNum: number | null = null;

          if (aIsNumber) {
            aNum = aVal;
          } else if (typeof aVal === 'string' && aVal !== '') {
            const parsed = Number(aVal);
            if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
              aNum = parsed;
            }
          }

          if (bIsNumber) {
            bNum = bVal;
          } else if (typeof bVal === 'string' && bVal !== '') {
            const parsed = Number(bVal);
            if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
              bNum = parsed;
            }
          }

          // If both are numeric, compare as numbers
          if (aNum !== null && bNum !== null) {
            comparison = aNum - bNum;
          } else {
            // At least one is not numeric, use locale-aware string comparison
            // Convert to strings to ensure consistent comparison (matching test expectations)
            const aStr = String(aVal);
            const bStr = String(bVal);
            comparison = aStr.localeCompare(bStr);
          }

          if (comparison !== 0) {
            return direction === 'asc' ? comparison : -comparison;
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

  private async _getNextTransactionId(): Promise<TransactionId> {
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
      throw new Error('Transaction counter row not found after update');
    }
    const row = result[0] as Record<string, unknown>;
    return Number(row.last_tx);
  }

  private async _writeDatomsInternal(datoms: DatomInput[], tx: TransactionId): Promise<void> {
    if (datoms.length === 0) return;

    // Batch inserts to avoid SQLite's SQL variable limit (typically 999)
    // Using batches of 199 datoms (199 * 5 params = 995 variables, safely under limit)
    const BATCH_SIZE = 199;

    for (let i = 0; i < datoms.length; i += BATCH_SIZE) {
      const batch = datoms.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const sql = `
        INSERT INTO ${this.tableName} (e, a, v, tx, op)
        VALUES ${placeholders}
        ON CONFLICT DO NOTHING
      `;

      const params = batch.flatMap(d => {
        let value = d.v;
        if (value === undefined) {
          value = '__UNDEFINED__';
        }
        return [String(d.e), String(d.a), JSON.stringify(value), tx, d.op];
      });

      await this.connection.execute(sql, params);
    }
  }

  async _getLatestTransaction(): Promise<Transaction> {
    await this._ensureInitialized();
    const sql = `SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1`;
    const result = await this.connection.query(sql);
    if (!result || result.length === 0) {
      // No transactions yet
      return {txId: 0, datoms: [], meta: undefined};
    }
    const row = result[0] as Record<string, unknown>;
    const txId = Number(row.last_tx);

    // Get all datoms for this transaction using history view
    const datoms = await this._executeHistoryQuery({tx: txId});

    return {
      txId,
      datoms,
      meta: undefined, // Metadata is not persisted in SQLite implementation
    };
  }

  async _destroy(config: {retentionCount: number}): Promise<number> {
    await this._ensureInitialized();

    if (config.retentionCount < 1) {
      throw new Error(
        'retentionCount must be at least 1 to ensure at least one datom is kept per (entity, attribute) pair',
      );
    }

    // Use window function to rank datoms per (e, a) pair by transaction ID descending
    // Delete all datoms where rank > retentionCount
    // This keeps only the latest N datoms per (e, a) pair
    // SQLite supports window functions since version 3.25.0
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
    const result = await this.connection.query(sql, params);
    return result.length;
  }

  private async _datomsWithMetadataInternal(
    options: DatomsQuery,
    viewConfig: ViewConfig,
  ): Promise<DatomsResultEnvelope> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    let result: Datom[];

    if (viewConfig.type === 'current') {
      result = await this._executeCurrentQuery(options);
    } else if (viewConfig.type === 'asOf') {
      result = await this._executeAsOfQuery(options, viewConfig.txId);
    } else if (viewConfig.type === 'since') {
      result = await this._executeSinceQuery(options, viewConfig.txId);
    } else if (viewConfig.type === 'history') {
      result = await this._executeHistoryQuery(options);
    } else if (viewConfig.type === 'speculative') {
      result = await this._executeSpeculativeQuery(options, viewConfig.datoms);
    } else {
      // TypeScript exhaustiveness check
      const _exhaustive: never = viewConfig;
      throw new Error(`Unknown view config type: ${(_exhaustive as ViewConfig).type}`);
    }

    const executionTime = performance.now() - startTime;
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = result.length;

    return {
      data: result,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private async _queryWithMetadataInternal<TFind extends Record<string, DatalogQueryFindVariable>>(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig,
  ): Promise<QueryResultEnvelope<TFind>> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    // Create read context
    // Extract context, but ensure db and query fields are not overwritten
    const {db: _, query: __, ...restContext} = context || {};
    // Merge db into query.context so hooks can access it via query.context.db
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

    // Run before-read hooks (pass enhanced query with db in context)
    const beforeResult = await this.hooks.runBeforeRead(enhancedQuery, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError('Query blocked by hooks', beforeResult.errors);
    }

    const modifiedQuery = beforeResult.query;

    if (modifiedQuery.where.length === 0) {
      const executionTime = performance.now() - startTime;
      return {
        data: [],
        metadata: {
          executionTimeMs: executionTime,
          resultCount: 0,
        },
      };
    }

    // For single clause queries, use optimized path
    if (modifiedQuery.where.length === 1) {
      const clause = modifiedQuery.where[0];
      if (!clause || !isQueryPattern(clause)) {
        throw new Error('Only QueryPattern clauses are supported');
      }
      const {e: entityVal, a: attributeVal, v: valueVal} = clause;
      const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
      const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const datoms = await this._datomsWithMetadataInternal(
        {
          e: entity,
          a: attribute,
          v: value,
          op: true,
          viewConfig,
        },
        viewConfig,
      );

      // Run after-read hooks
      const afterResult = await this.hooks.runAfterRead(datoms.data, ctx);

      if (afterResult.errors && afterResult.errors.length > 0) {
        throw new QueryError('Query blocked by after-read hooks', afterResult.errors);
      }

      const results = afterResult.datoms.map(datom => {
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

      const projected = project(results, modifiedQuery.find, modifiedQuery.where);
      const finalResult = this._applyOrderAndLimit(projected, modifiedQuery) as QueryResult<TFind>;
      const executionTime = performance.now() - startTime;
      metadata.executionTimeMs = executionTime;
      metadata.resultCount = finalResult.length;
      metadata.executionStrategy = 'single-clause-optimized';

      return {
        data: finalResult,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    // For multi-clause queries, extract datoms first for afterRead hooks
    const allDatomsSet = new Set<string>();
    const allDatoms: Datom[] = [];

    for (const clause of modifiedQuery.where) {
      if (!isQueryPattern(clause)) {
        continue;
      }
      const {e: entityVal, a: attributeVal, v: valueVal} = clause;
      const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
      const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const clauseDatoms = await this._datomsWithMetadataInternal(
        {
          e: entity,
          a: attribute,
          v: value,
          op: true,
          viewConfig,
        },
        viewConfig,
      );

      for (const datom of clauseDatoms.data) {
        const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
        if (!allDatomsSet.has(key)) {
          allDatomsSet.add(key);
          allDatoms.push(datom);
        }
      }
    }

    // Run after-read hooks
    const afterResult = await this.hooks.runAfterRead(allDatoms, ctx);

    if (afterResult.errors && afterResult.errors.length > 0) {
      throw new QueryError('Query blocked by after-read hooks', afterResult.errors);
    }

    // For speculative views, we need to use in-memory join logic
    // For other views, we can use SQL-based joins
    if (viewConfig.type === 'speculative') {
      // Use in-memory join logic for speculative queries
      const firstClause = modifiedQuery.where[0];
      if (!firstClause || !isQueryPattern(firstClause)) {
        throw new Error('First clause must be a QueryPattern');
      }
      const {e: entityVal, a: attributeVal, v: valueVal} = firstClause;
      const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
      const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
      const value = isVariable(valueVal) ? undefined : (valueVal as Value);

      const firstDatoms = await this._datomsWithMetadataInternal(
        {
          e: entity,
          a: attribute,
          v: value,
          viewConfig,
        },
        viewConfig,
      );

      const firstResults = firstDatoms.data.map(datom => {
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

      let results = firstResults;
      for (let i = 1; i < modifiedQuery.where.length; i++) {
        const clause = modifiedQuery.where[i];
        if (!clause || !isQueryPattern(clause)) {
          throw new Error('Only QueryPattern clauses are supported in joins');
        }
        const {e: entityVal, a: attributeVal, v: valueVal} = clause;
        const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
        const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
        const value = isVariable(valueVal) ? undefined : (valueVal as Value);

        const clauseDatoms = await this._datomsWithMetadataInternal(
          {
            e: entity,
            a: attribute,
            v: value,
          },
          viewConfig,
        );

        const clauseResults = clauseDatoms.data.map(datom => {
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

        results = joinResults(results, clauseResults, modifiedQuery.where.slice(0, i + 1));
      }

      const projected = project(results, modifiedQuery.find, modifiedQuery.where);
      const finalResult = this._applyOrderAndLimit(projected, modifiedQuery) as QueryResult<TFind>;
      const executionTime = performance.now() - startTime;
      metadata.executionTimeMs = executionTime;
      metadata.resultCount = finalResult.length;
      metadata.executionStrategy = 'in-memory-speculative';

      return {
        data: finalResult,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    }

    // For non-speculative views, use SQL-based query execution
    // Re-execute query with filtered datoms
    const finalResult = (await this._executeDatalogWithSQLAndFilteredDatoms(
      modifiedQuery,
      afterResult.datoms,
    )) as QueryResult<TFind>;
    const executionTime = performance.now() - startTime;
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = finalResult.length;
    metadata.executionStrategy = 'sql-joins';

    return {
      data: finalResult,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
}
