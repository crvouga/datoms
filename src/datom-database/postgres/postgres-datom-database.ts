/**
 * PostgreSQL database implementation
 * Accepts a SqlConnection interface for PostgreSQL-compatible databases
 */

import type {DatalogQuery, DatalogQueryFindVariable, QueryClause} from '../../datalog/datalog.js';

import type {Attribute, Datom, DatomInput, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {SQLDatabase} from '../../sql-database/sql-database.js';
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
import {parseAggregation} from '../in-memory/aggregations/parser.js';
import {isQueryPattern, isVariable, stripQuestionMark} from '../shared/datalog-helpers.js';
import {ConfiguredDatabaseView} from '../views/configured-database-view.js';
import type {
  DatabaseView,
  DatomsQuery,
  QueryResult,
  QueryResultEnvelope,
} from '../views/database-view.js';
import type {ViewConfig} from '../views/view-config.js';
import {aggregationToSQL} from './aggregations/helpers.js';

/**
 * Convert a DatalogQuery to PostgreSQL SQL
 * Returns the SQL string and parameter array
 */
function datalogToPostgresSQL(
  query: DatalogQuery,
  tableName = 'datoms',
  viewConfig?: ViewConfig,
): {sql: string; params: unknown[]} {
  const allClauses = query.where;
  const params: unknown[] = [];

  // Separate QueryPattern clauses from predicate clauses
  const patternClauses: QueryClause[] = [];
  const predicateClauses: QueryClause[] = [];
  for (const clause of allClauses) {
    if (isQueryPattern(clause)) {
      patternClauses.push(clause);
    } else if (Array.isArray(clause)) {
      // Predicate clause like ['=', '?tx', value]
      predicateClauses.push(clause);
    }
  }

  if (patternClauses.length === 0) {
    throw new Error('Query must have at least one pattern clause');
  }

  // Build CTEs for each pattern clause with deduplication using DISTINCT ON
  const ctes: string[] = [];
  for (let i = 0; i < patternClauses.length; i++) {
    const clause = patternClauses[i];
    if (!clause || !isQueryPattern(clause)) {
      throw new Error('Only QueryPattern clauses are supported in SQL queries');
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;
    const alias = `d${i}`;

    const conditions: string[] = [];

    // Add filters for bound values
    if (!isVariable(entityVal)) {
      conditions.push('e = ?');
      params.push(String(entityVal));
    }
    if (!isVariable(attributeVal)) {
      conditions.push('a = ?');
      params.push(String(attributeVal));
    }
    if (!isVariable(valueVal)) {
      let value = valueVal as Value;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      conditions.push('v = ?::jsonb');
      params.push(JSON.stringify(value));
    }

    // Add transaction filter for asOf and since views
    if (viewConfig?.type === 'asOf') {
      conditions.push('tx <= ?');
      params.push(viewConfig.txId);
    } else if (viewConfig?.type === 'since') {
      conditions.push('tx > ?');
      params.push(viewConfig.txId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // For history queries, don't use DISTINCT ON - return all datoms including duplicates
    // For asOf queries, deduplicate by (e, a) to keep latest tx per attribute
    // For other queries, deduplicate by (e, a, v) to support multi-valued attributes
    const isHistory = viewConfig?.type === 'history';
    const distinctOn = viewConfig?.type === 'asOf' ? '(e, a)' : '(e, a, v)';
    const orderBy = viewConfig?.type === 'asOf' ? 'e, a, tx DESC' : 'e, a, v, tx DESC';

    // For history queries, don't filter by op = true (include retractions)
    // For other queries, filter to only active (op = true) datoms
    const activeFilter = isHistory ? '' : 'WHERE op = true';

    let cte: string;
    if (isHistory) {
      // History queries: no deduplication, return all datoms
      cte = `
        ${alias} AS (
          SELECT e, a, v, tx, op
          FROM ${tableName}
          ${whereClause}
          ORDER BY tx ASC, e ASC, a ASC
        ),
        ${alias}_active AS (
          SELECT e, a, v, tx, op
          FROM ${alias}
        )`;
    } else {
      // Regular queries: use DISTINCT ON for deduplication
      cte = `
        ${alias} AS (
          SELECT DISTINCT ON ${distinctOn}
            e, a, v, tx, op
          FROM ${tableName}
          ${whereClause}
          ORDER BY ${orderBy}
        ),
        ${alias}_active AS (
          SELECT e, a, v, tx, op
          FROM ${alias}
          ${activeFilter}
        )`;
    }

    ctes.push(cte);
  }

  // Map variables to their column references
  const variableToColumn: Map<string, string> = new Map();
  for (let i = 0; i < patternClauses.length; i++) {
    const clause = patternClauses[i];
    if (!clause || !isQueryPattern(clause)) {
      continue;
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;
    const alias = `d${i}_active`;
    if (isVariable(entityVal)) {
      if (!variableToColumn.has(entityVal as string)) {
        variableToColumn.set(entityVal as string, `${alias}.e`);
      }
    }
    if (isVariable(attributeVal)) {
      if (!variableToColumn.has(attributeVal as string)) {
        variableToColumn.set(attributeVal as string, `${alias}.a`);
      }
    }
    if (isVariable(valueVal)) {
      if (!variableToColumn.has(valueVal as string)) {
        variableToColumn.set(valueVal as string, `${alias}.v`);
      }
    }
  }

  // Build JOIN conditions based on shared variables
  const variableToClause: Map<string, {clauseIndex: number; field: string}[]> = new Map();

  for (let i = 0; i < patternClauses.length; i++) {
    const clause = patternClauses[i];
    if (!clause || !isQueryPattern(clause)) {
      throw new Error('Only QueryPattern clauses are supported in JOIN conditions');
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;

    if (isVariable(entityVal)) {
      const varName = entityVal as string;
      if (!variableToClause.has(varName)) {
        variableToClause.set(varName, []);
      }
      variableToClause.get(varName)?.push({clauseIndex: i, field: 'e'});
    }
    if (isVariable(attributeVal)) {
      const varName = attributeVal as string;
      if (!variableToClause.has(varName)) {
        variableToClause.set(varName, []);
      }
      variableToClause.get(varName)?.push({clauseIndex: i, field: 'a'});
    }
    if (isVariable(valueVal)) {
      const varName = valueVal as string;
      if (!variableToClause.has(varName)) {
        variableToClause.set(varName, []);
      }
      variableToClause.get(varName)?.push({clauseIndex: i, field: 'v'});
    }
  }

  // Build JOIN conditions for shared variables
  const joinConditions: string[] = [];
  for (const occurrences of variableToClause.values()) {
    if (occurrences.length > 1) {
      for (let i = 1; i < occurrences.length; i++) {
        const prev = occurrences[i - 1];
        const curr = occurrences[i];
        if (!prev || !curr) continue;
        const prevAlias = `d${prev.clauseIndex}_active`;
        const currAlias = `d${curr.clauseIndex}_active`;

        // Handle type casting: v is jsonb, e and a are text
        let prevExpr = `${prevAlias}.${prev.field}`;
        let currExpr = `${currAlias}.${curr.field}`;

        if (prev.field === 'v' && (curr.field === 'e' || curr.field === 'a')) {
          prevExpr = `${prevAlias}.v::text`;
        } else if ((prev.field === 'e' || prev.field === 'a') && curr.field === 'v') {
          currExpr = `${currAlias}.v::text`;
        } else if (prev.field === 'v' && curr.field === 'v') {
          prevExpr = `${prevAlias}.v::text`;
          currExpr = `${currAlias}.v::text`;
        }

        joinConditions.push(`${prevExpr} = ${currExpr}`);
      }
    }
  }

  // Build the final SQL query
  const cteClause = ctes.length > 0 ? `WITH ${ctes.join(', ')}` : '';

  const fromClause = 'FROM d0_active';
  const joinClauses: string[] = [];

  // Build JOIN clauses
  for (let i = 1; i < patternClauses.length; i++) {
    const alias = `d${i}_active`;
    const conditions: string[] = [];

    for (const joinCond of joinConditions) {
      const parts = joinCond.split(' = ');
      if (parts.length === 2 && parts[0] && parts[1]) {
        const leftMatch = parts[0].trim().match(/^(d\d+)_active\./);
        const rightMatch = parts[1].trim().match(/^(d\d+)_active\./);

        if (!leftMatch || !rightMatch || !leftMatch[1] || !rightMatch[1]) continue;

        const leftAlias = `${leftMatch[1]}_active`;
        const rightAlias = `${rightMatch[1]}_active`;

        if (leftAlias !== alias && rightAlias !== alias) {
          continue;
        }

        const otherAlias = leftAlias === alias ? rightAlias : leftAlias;
        const otherIndexMatch = otherAlias.match(/^d(\d+)_active$/);
        const otherIndex = otherIndexMatch?.[1] ? Number.parseInt(otherIndexMatch[1]) : -1;
        if (otherIndex < i) {
          if (rightAlias === alias) {
            conditions.push(`${parts[1].trim()} = ${parts[0].trim()}`);
          } else {
            conditions.push(joinCond);
          }
        }
      }
    }

    if (conditions.length > 0) {
      joinClauses.push(`JOIN ${alias} ON ${conditions.join(' AND ')}`);
    } else {
      // If no explicit JOIN conditions found, try to join to the previous table
      const prevAlias = `d${i - 1}_active`;
      const currentClause = patternClauses[i];
      const prevClause = patternClauses[i - 1];
      if (
        currentClause &&
        prevClause &&
        isQueryPattern(currentClause) &&
        isQueryPattern(prevClause)
      ) {
        const currE = currentClause.e;
        const prevE = prevClause.e;
        if (isVariable(currE) && isVariable(prevE) && currE === prevE) {
          joinClauses.push(`JOIN ${alias} ON ${prevAlias}.e = ${alias}.e`);
        } else {
          joinClauses.push(`CROSS JOIN ${alias}`);
        }
      } else {
        joinClauses.push(`CROSS JOIN ${alias}`);
      }
    }
  }

  const joinClause = joinClauses.join(' ');

  // Build SELECT columns
  const selectColumns: string[] = [];
  const groupByColumns: string[] = [];
  const findKeys = Object.keys(query.find);

  // Handle empty find clause - select all variables from where clause
  if (findKeys.length === 0) {
    // Collect all unique variables from pattern clauses
    const allVariables = new Set<string>();
    for (const clause of patternClauses) {
      if (!clause || !isQueryPattern(clause)) continue;
      const {e: entityVal, a: attributeVal, v: valueVal} = clause;
      if (isVariable(entityVal)) {
        allVariables.add(entityVal as string);
      }
      if (isVariable(attributeVal)) {
        allVariables.add(attributeVal as string);
      }
      if (isVariable(valueVal)) {
        allVariables.add(valueVal as string);
      }
    }
    // Select all variables
    for (const varName of allVariables) {
      const columnRef = variableToColumn.get(varName);
      if (columnRef) {
        const varColName = stripQuestionMark(varName);
        selectColumns.push(`${columnRef} AS "${varColName}"`);
      }
    }
  } else {
    for (const outputKey of findKeys) {
      const expr = query.find[outputKey];
      const agg = parseAggregation(expr);

      if (agg) {
        // Aggregation
        const varName = agg.variable;
        const columnRef = variableToColumn.get(varName);
        if (columnRef) {
          const sqlAgg = aggregationToSQL(expr, columnRef, outputKey);
          if (sqlAgg?.sql) {
            selectColumns.push(sqlAgg.sql);
          } else {
            // Aggregation not supported or failed to convert
            selectColumns.push(`NULL AS "${outputKey}"`);
          }
        } else {
          // Variable not found in variableToColumn - this shouldn't happen for valid queries
          // but if it does, return NULL
          selectColumns.push(`NULL AS "${outputKey}"`);
        }
      } else {
        // Regular variable
        let varName: string;
        if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
          varName = expr[0];
        } else if (typeof expr === 'string') {
          varName = expr;
        } else {
          continue;
        }

        // Special handling for op and tx fields
        if (varName === '?op') {
          selectColumns.push(`d0_active.op AS "${outputKey}"`);
          groupByColumns.push('d0_active.op');
        } else if (varName === '?tx') {
          selectColumns.push(`d0_active.tx AS "${outputKey}"`);
          groupByColumns.push('d0_active.tx');
        } else {
          const columnRef = variableToColumn.get(varName);
          if (columnRef) {
            selectColumns.push(`${columnRef} AS "${outputKey}"`);
            groupByColumns.push(columnRef);
          }
        }
      }
    }
  }

  // Build predicate WHERE conditions
  const predicateConditions: string[] = [];
  for (const predicate of predicateClauses) {
    if (Array.isArray(predicate) && predicate.length === 3) {
      const [op, varName, value] = predicate;
      if (typeof varName === 'string' && varName.startsWith('?')) {
        if (varName === '?tx') {
          if (op === '=') {
            params.push(value);
            predicateConditions.push('d0_active.tx = ?');
          } else if (op === '<=') {
            params.push(value);
            predicateConditions.push('d0_active.tx <= ?');
          }
          continue;
        }

        const columnRef = variableToColumn.get(varName);
        if (columnRef) {
          if (op === '=') {
            if (columnRef.includes('.v')) {
              params.push(JSON.stringify(value));
              predicateConditions.push(`${columnRef} = ?::jsonb`);
            } else {
              params.push(String(value));
              predicateConditions.push(`${columnRef} = ?`);
            }
          } else if (op === '<=') {
            if (columnRef.includes('.v')) {
              params.push(JSON.stringify(value));
              predicateConditions.push(`(${columnRef}::jsonb)::text::numeric <= ?::numeric`);
            } else {
              params.push(String(value));
              predicateConditions.push(`${columnRef} <= ?`);
            }
          }
        }
      }
    }
  }

  const whereClause =
    predicateConditions.length > 0 ? `WHERE ${predicateConditions.join(' AND ')}` : '';

  // Build GROUP BY clause if we have aggregations
  // Only add GROUP BY if we have non-aggregated columns to group by
  let groupByClause = '';
  const hasAggregations =
    findKeys.length > 0 && findKeys.some(key => parseAggregation(query.find[key]));
  if (hasAggregations && groupByColumns.length > 0) {
    groupByClause = `GROUP BY ${groupByColumns.join(', ')}`;
  }

  // Ensure we have at least one SELECT column
  if (selectColumns.length === 0) {
    selectColumns.push('1 AS "_empty"');
  }

  // Build ORDER BY clause
  let orderByClause = '';
  if (query.orderBy && query.orderBy.length > 0) {
    const orderParts: string[] = [];
    for (const [variable, direction] of query.orderBy) {
      const columnRef = variableToColumn.get(variable);
      if (columnRef) {
        const dir = direction.toUpperCase();
        orderParts.push(`${columnRef} ${dir}`);
      }
    }
    if (orderParts.length > 0) {
      orderByClause = `ORDER BY ${orderParts.join(', ')}`;
    }
  }

  // Build LIMIT clause
  const limitClause = query.limit ? 'LIMIT ?' : '';
  if (query.limit) {
    params.push(query.limit);
  }

  const sql = `
    ${cteClause}
    SELECT ${selectColumns.join(', ')}
    ${fromClause}
    ${joinClause}
    ${whereClause}
    ${groupByClause}
    ${orderByClause}
    ${limitClause}
  `;

  return {sql: sql.trim(), params};
}

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

    // Basic indexes
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e_a_tx ON ${this.tableName}(e, a, tx DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_v_tx ON ${this.tableName}(a, v, tx DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_active ON ${this.tableName}(e, a, tx DESC) WHERE op = true`,
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tx ON ${this.tableName}(tx DESC)`,
    ];

    await this.sqlDb.execute(createTableSql);
    for (const indexSql of indexes) {
      await this.sqlDb.execute(indexSql);
    }

    // Create transaction counter table
    const txTableSql = `
      CREATE TABLE IF NOT EXISTS ${this.tableName}_tx (
        id BIGINT PRIMARY KEY,
        last_tx BIGINT NOT NULL DEFAULT 0
      )
    `;
    await this.sqlDb.execute(txTableSql);

    // Initialize transaction counter if needed
    const initTxSql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      SELECT 1, 0
      WHERE NOT EXISTS (SELECT 1 FROM ${this.tableName}_tx WHERE id = 1)
    `;
    await this.sqlDb.execute(initTxSql);

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.sqlDb.close) {
      await this.sqlDb.close();
    }
    this.initialized = false;
  }

  hook(hook: Hook): void {
    this.hooks.register(hook);
  }

  private async _writeDatoms(datoms: DatomInput[]): Promise<TransactionId> {
    const txResult = await this._getNextTransactionId();
    const tx = txResult.txId;

    if (
      this.sqlDb.beginTransaction &&
      this.sqlDb.commitTransaction &&
      this.sqlDb.rollbackTransaction
    ) {
      await this.sqlDb.beginTransaction();
      try {
        await this._writeDatomsInternal(datoms, tx);
        await this.sqlDb.commitTransaction();
      } catch (error) {
        await this.sqlDb.rollbackTransaction();
        throw error;
      }
    } else {
      await this._writeDatomsInternal(datoms, tx);
    }

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
        await this._validateDatoms([datom], true, subs);
        adds.push(datom);
      } else {
        await this._validateDatoms([datom], false);
        subs.push(datom);
      }
    }

    // Convert to datoms for transaction object
    const allDatoms: Datom[] = [];
    const latestTx = await this._getLatestTransaction();
    const txId = (latestTx.txId ?? 0) + 1;

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

  private async _validateDatoms(
    datoms: DatomInput[],
    _isAdd: boolean,
    _subsInSameTransaction?: DatomInput[],
  ): Promise<void> {
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
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      conditions.push('v = ?::jsonb');
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

    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    const combinedWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let opFilterAfter = '';
    if (options.op === undefined || options.op === true) {
      opFilterAfter = 'WHERE op = true';
    } else if (options.op === false) {
      opFilterAfter = 'WHERE op = false';
    }

    const sql = `
      WITH latest_datoms AS (
        SELECT DISTINCT ON (e, a, v)
          e, a, v, tx, op
        FROM ${this.tableName}
        ${combinedWhereClause}
        ORDER BY e, a, v, tx DESC
      )
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM latest_datoms
      ${opFilterAfter}
      ORDER BY
        CASE 
          WHEN e ~ '^-{0,1}[0-9]+$' THEN e::BIGINT 
          ELSE 0 
        END,
        a
      ${limitClause}
      ${offsetClause}
    `.trim();

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.sqlDb.query(sql, params);
    return this._mapRowsToDatoms(rows);
  }

  private async _executeAsOfQuery(options: DatomsQuery, txId: TransactionId): Promise<Datom[]> {
    await this._ensureInitialized();

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
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      conditions.push('v = ?::jsonb');
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

    const sql = `
      SELECT DISTINCT ON (e, a)
        e, a, v, tx, op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY e, a, tx DESC
    `;

    const finalSql = `
      WITH latest_datoms AS (${sql})
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM latest_datoms
      WHERE op = true
      ORDER BY
        CASE 
          WHEN e ~ '^-{0,1}[0-9]+$' THEN e::BIGINT 
          ELSE 0 
        END,
        a
      ${limitClause}
      ${offsetClause}
    `.trim();

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.sqlDb.query(finalSql, params);
    return this._mapRowsToDatoms(rows);
  }

  private async _executeHistoryQuery(options: DatomsQuery): Promise<Datom[]> {
    await this._ensureInitialized();

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
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      conditions.push('v = ?::jsonb');
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
    `.trim();

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.sqlDb.query(sql, params);
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
      let value = options.v;
      if (value === undefined) {
        value = '__UNDEFINED__';
      }
      conditions.push('v = ?::jsonb');
      params.push(JSON.stringify(value));
    }

    // Filter to only datoms with tx > txId
    conditions.push('tx > ?');
    params.push(txId);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    const sql = `
      SELECT DISTINCT ON (e, a, v)
        e, a, v, tx, op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY e, a, v, tx DESC
    `;

    const finalSql = `
      WITH latest_datoms AS (${sql})
      SELECT 
        e,
        a,
        v,
        tx,
        op
      FROM latest_datoms
      WHERE op = true
      ORDER BY
        CASE 
          WHEN e ~ '^-{0,1}[0-9]+$' THEN e::BIGINT 
          ELSE 0 
        END,
        a
      ${limitClause}
      ${offsetClause}
    `.trim();

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const rows = await this.sqlDb.query(finalSql, params);
    return this._mapRowsToDatoms(rows);
  }

  private async _executeSpeculativeQuery(
    options: DatomsQuery,
    speculativeDatoms: Datom[],
  ): Promise<Datom[]> {
    await this._ensureInitialized();

    // For speculative queries, fetch base datoms and merge with speculative changes
    const baseDatoms = await this._executeCurrentQuery({});

    // Create a map of base datoms by (entity, attribute, value) for efficient lookup
    const baseMap = new Map<string, Datom>();
    for (const datom of baseDatoms) {
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
      let entity: EntityId = row.e as EntityId;
      if (typeof entity === 'string') {
        if (/^-?\d+$/.test(entity)) {
          entity = Number.parseInt(entity, 10);
        }
      }

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

  async query<
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
    viewConfig?: ViewConfig,
  ): Promise<{results: QueryResult}> {
    const {sql, params} = datalogToPostgresSQL(query, this.tableName, viewConfig);

    const rows = await this.sqlDb.query(sql, params);

    // When we have aggregations only (no GROUP BY), we should get exactly 1 row
    // If we get multiple rows, something is wrong with the SQL
    const findKeys = Object.keys(query.find);
    const hasAggregations =
      findKeys.length > 0 && findKeys.some(key => parseAggregation(query.find[key]));
    if (hasAggregations && rows.length > 1) {
      // Take only the first row - aggregations without GROUP BY should return 1 row
      const firstRow = rows[0];
      if (firstRow) {
        rows.length = 0;
        rows.push(firstRow);
      }
    }

    // Convert SQL results back to QueryResult format
    const results: Record<string, Value | Attribute>[] = rows.map((row: DatabaseRow) => {
      const result: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        let value: unknown = row[key];
        // PostgreSQL stores values as JSONB, so parse them
        if (typeof value === 'string') {
          if (/^-?\d+$/.test(value)) {
            const num = Number.parseInt(value, 10);
            if (!Number.isNaN(num)) {
              value = num;
            } else {
              try {
                value = JSON.parse(value);
              } catch {
                // Not valid JSON, keep as string
              }
            }
          } else {
            try {
              value = JSON.parse(value);
            } catch {
              // Not valid JSON, keep as string
            }
          }
        }
        // For aggregation results, handle numeric strings specially
        let finalValue = value;
        if (typeof value === 'string') {
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

  private async _writeDatomsInternal(datoms: DatomInput[], tx: TransactionId): Promise<void> {
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

      await this.sqlDb.execute(sql, params);
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
    const historyResult = await this._executeHistoryQuery({tx: txId});

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
    viewConfig: ViewConfig,
  ): Promise<{data: Datom[]}> {
    await this._ensureInitialized();

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
      const _exhaustive: never = viewConfig;
      throw new Error(`Unknown view config type: ${(_exhaustive as ViewConfig).type}`);
    }

    return {
      data: result,
    };
  }

  private async _queryWithMetadataInternal<TFind extends Record<string, DatalogQueryFindVariable>>(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
    context: Record<string, unknown> | undefined,
    viewConfig: ViewConfig,
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
      const patternClauses: QueryClause[] = [];
      const predicateClauses: QueryClause[] = [];
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
        for (const outputKey of Object.keys(modifiedQuery.find)) {
          const expr = modifiedQuery.find[outputKey];
          let varName: string | undefined;
          if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
            varName = expr[0];
          } else if (typeof expr === 'string') {
            varName = expr;
          }
          if (varName && varName in row) {
            result[outputKey] = row[varName];
          }
        }
        return result as QueryResult<TFind>[number];
      }) as QueryResult<TFind>;

      // Apply ordering
      if (modifiedQuery.orderBy) {
        projected.sort((a, b) => {
          for (const [variable, direction] of modifiedQuery.orderBy ?? []) {
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
        for (const [variable, direction] of modifiedQuery.orderBy ?? []) {
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
