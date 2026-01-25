/**
 * Converts DatalogQuery to PostgreSQL SQL
 */

import type {
  DatalogQuery,
  DatalogQueryFindVariable,
  DatalogQueryWhereClause,
} from '../../datalog-query.js';
import type {Attribute, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {ViewConfig} from '../views/view-config.js';
import {isQueryPattern, isVariable, stripQuestionMark} from '../shared/datalog-helpers.js';
import {aggregationToSQL} from './aggregations/helpers.js';

/**
 * Convert a DatalogQuery to PostgreSQL SQL
 * Returns the SQL string and parameter array
 */
export function datalogToPostgresSQL(
  query: DatalogQuery,
  tableName = 'datoms',
  viewConfig?: ViewConfig,
): {sql: string; params: unknown[]} {
  const params: unknown[] = [];

  // Separate QueryPattern clauses from predicate clauses
  const {patternClauses, predicateClauses} = _separateClauses(query.where);

  if (patternClauses.length === 0) {
    throw new Error('Query must have at least one pattern clause');
  }

  // Check if there's an op predicate that would override default filtering
  const hasOpPredicate = predicateClauses.some(
    p => Array.isArray(p) && p.length === 3 && p[1] === '?op',
  );

  // Build CTEs for each pattern clause with deduplication using DISTINCT ON
  const ctes = _buildCTEs(patternClauses, tableName, viewConfig, params, hasOpPredicate);

  // Map variables to their column references
  const variableToColumn = _buildVariableMapping(patternClauses);

  // Build JOIN conditions based on shared variables
  const joinClause = _buildJoinClauses(patternClauses);

  // Build SELECT columns
  const {selectColumns, groupByColumns} = _buildSelectClause(
    query,
    patternClauses,
    variableToColumn,
    params,
  );

  // Build predicate WHERE conditions
  const whereClause = _buildWhereClause(predicateClauses, variableToColumn, params);

  // Build GROUP BY clause if we have aggregations
  const groupByClause = _buildGroupByClause(query, groupByColumns);

  // Ensure we have at least one SELECT column
  if (selectColumns.length === 0) {
    selectColumns.push('1 AS "_empty"');
  }

  // Build ORDER BY clause
  const orderByClause = _buildOrderByClause(query, variableToColumn);

  // Build LIMIT clause
  const limitClause = _buildLimitClause(query, params);

  // Build OFFSET clause
  const offsetClause = _buildOffsetClause(query, params);

  // Build the final SQL query
  const cteClause = ctes.length > 0 ? `WITH ${ctes.join(', ')}` : '';
  const fromClause = 'FROM d0_active';

  const sql = `
    ${cteClause}
    SELECT ${selectColumns.join(', ')}
    ${fromClause}
    ${joinClause}
    ${whereClause}
    ${groupByClause}
    ${orderByClause}
    ${limitClause}
    ${offsetClause}
  `;

  return {sql: sql.trim(), params};
}

// ============================================================================
// High-Level Private Functions
// ============================================================================

/**
 * Separate QueryPattern clauses from predicate clauses
 */
function _separateClauses(allClauses: DatalogQueryWhereClause[]): {
  patternClauses: DatalogQueryWhereClause[];
  predicateClauses: DatalogQueryWhereClause[];
} {
  const patternClauses: DatalogQueryWhereClause[] = [];
  const predicateClauses: DatalogQueryWhereClause[] = [];

  for (const clause of allClauses) {
    if (isQueryPattern(clause)) {
      patternClauses.push(clause);
    } else if (Array.isArray(clause)) {
      // Predicate clause like ['=', '?tx', value]
      predicateClauses.push(clause);
    }
  }

  return {patternClauses, predicateClauses};
}

/**
 * Build CTEs for all pattern clauses
 */
function _buildCTEs(
  patternClauses: DatalogQueryWhereClause[],
  tableName: string,
  viewConfig: ViewConfig | undefined,
  params: unknown[],
  hasOpPredicate: boolean,
): string[] {
  const ctes: string[] = [];

  for (let i = 0; i < patternClauses.length; i++) {
    const clause = patternClauses[i];
    if (!clause || !isQueryPattern(clause)) {
      throw new Error('Only QueryPattern clauses are supported in SQL queries');
    }

    const cte = _buildCTEForPattern(clause, i, tableName, viewConfig, params, hasOpPredicate);
    ctes.push(cte);
  }

  return ctes;
}

/**
 * Map variables to their column references
 */
function _buildVariableMapping(patternClauses: DatalogQueryWhereClause[]): Map<string, string> {
  const variableToColumn: Map<string, string> = new Map();

  for (let i = 0; i < patternClauses.length; i++) {
    const clause = patternClauses[i];
    if (!clause || !isQueryPattern(clause)) {
      continue;
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;
    const alias = `d${i}_active`;

    if (isVariable(entityVal)) {
      const varName = entityVal as string;
      if (!variableToColumn.has(varName)) {
        variableToColumn.set(varName, `${alias}.e`);
      }
    }
    if (isVariable(attributeVal)) {
      const varName = attributeVal as string;
      if (!variableToColumn.has(varName)) {
        variableToColumn.set(varName, `${alias}.a`);
      }
    }
    if (isVariable(valueVal)) {
      const varName = valueVal as string;
      if (!variableToColumn.has(varName)) {
        variableToColumn.set(varName, `${alias}.v`);
      }
    }
  }

  return variableToColumn;
}

/**
 * Build JOIN clauses from shared variables
 */
function _buildJoinClauses(patternClauses: DatalogQueryWhereClause[]): string {
  const variableToClause = _mapVariableOccurrences(patternClauses);
  const joinConditions = _buildJoinConditions(variableToClause);

  const joinClauses: string[] = [];

  // Build JOIN clauses
  for (let i = 1; i < patternClauses.length; i++) {
    const joinClause = _buildJoinClauseForAlias(i, patternClauses, joinConditions);
    joinClauses.push(joinClause);
  }

  return joinClauses.join(' ');
}

/**
 * Build SELECT clause with columns and GROUP BY columns
 */
function _buildSelectClause(
  query: DatalogQuery,
  patternClauses: DatalogQueryWhereClause[],
  variableToColumn: Map<string, string>,
  params: unknown[],
): {selectColumns: string[]; groupByColumns: string[]} {
  const selectColumns: string[] = [];
  const groupByColumns: string[] = [];
  const findKeys = Object.keys(query.find);

  if (findKeys.length === 0) {
    _buildSelectColumnsEmpty(patternClauses, variableToColumn, selectColumns);
  } else {
    _buildSelectColumnsNonEmpty(
      query,
      patternClauses,
      variableToColumn,
      selectColumns,
      groupByColumns,
      params,
    );
  }

  return {selectColumns, groupByColumns};
}

/**
 * Build WHERE clause from predicate clauses
 */
function _buildWhereClause(
  predicateClauses: DatalogQueryWhereClause[],
  variableToColumn: Map<string, string>,
  params: unknown[],
): string {
  const predicateConditions: string[] = [];

  for (const predicate of predicateClauses) {
    if (Array.isArray(predicate) && predicate.length === 3) {
      _addPredicateCondition(predicate, variableToColumn, predicateConditions, params);
    }
  }

  return predicateConditions.length > 0 ? `WHERE ${predicateConditions.join(' AND ')}` : '';
}

/**
 * Build GROUP BY clause if we have aggregations
 */
function _buildGroupByClause(query: DatalogQuery, groupByColumns: string[]): string {
  const hasAggregations = Object.values(query.find).some(e => e.t !== 'identity');

  if (hasAggregations && groupByColumns.length > 0) {
    return `GROUP BY ${groupByColumns.join(', ')}`;
  }

  return '';
}

/**
 * Build ORDER BY clause
 */
function _buildOrderByClause(query: DatalogQuery, variableToColumn: Map<string, string>): string {
  if (!query.orderBy || query.orderBy.length === 0) {
    return '';
  }

  const orderParts: string[] = [];
  for (const orderBy of query.orderBy) {
    const {c: variable, t: direction} = orderBy;
    const columnRef = variableToColumn.get(variable);
    if (columnRef) {
      const dir = direction.toUpperCase();
      orderParts.push(`${columnRef} ${dir}`);
    }
  }

  return orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : '';
}

/**
 * Build LIMIT clause
 */
function _buildLimitClause(query: DatalogQuery, params: unknown[]): string {
  if (query.limit) {
    params.push(query.limit);
    return 'LIMIT ?';
  }
  return '';
}

/**
 * Build OFFSET clause
 */
function _buildOffsetClause(query: DatalogQuery, params: unknown[]): string {
  if (query.offset !== undefined) {
    params.push(query.offset);
    return 'OFFSET ?';
  }
  return '';
}

// ============================================================================
// Mid-Level Helper Functions
// ============================================================================

/**
 * Build CTE for a single pattern clause
 */
function _buildCTEForPattern(
  clause: DatalogQueryWhereClause,
  index: number,
  tableName: string,
  viewConfig: ViewConfig | undefined,
  params: unknown[],
  hasOpPredicate: boolean,
): string {
  if (!isQueryPattern(clause)) {
    throw new Error('Only QueryPattern clauses are supported');
  }

  const {e: entityVal, a: attributeVal, v: valueVal} = clause;
  const alias = `d${index}`;

  const conditions = _buildWhereConditions(entityVal, attributeVal, valueVal, viewConfig, params);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // For history queries, don't use DISTINCT ON - return all datoms including duplicates
  // For asOf queries, deduplicate by (e, a) to keep latest tx per attribute
  // For other queries, deduplicate by (e, a, v) to support multi-valued attributes
  const isHistory = viewConfig?.type === 'history';
  const distinctOn = viewConfig?.type === 'asOf' ? '(e, a)' : '(e, a, v)';
  const orderBy = viewConfig?.type === 'asOf' ? 'e, a, tx DESC' : 'e, a, v, tx DESC';

  // For history queries, don't filter by op = true (include retractions)
  // For other queries, filter to only active (op = true) datoms UNLESS there's an op predicate
  // If there's an op predicate, let it handle the filtering in the WHERE clause
  const activeFilter = isHistory || hasOpPredicate ? '' : 'WHERE op = true';

  if (isHistory) {
    // History queries: no deduplication, return all datoms
    return `
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
  }
  // Regular queries: use DISTINCT ON for deduplication
  return `
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

/**
 * Build WHERE conditions for pattern values
 */
function _buildWhereConditions(
  entityVal: unknown,
  attributeVal: unknown,
  valueVal: unknown,
  viewConfig: ViewConfig | undefined,
  params: unknown[],
): string[] {
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

  return conditions;
}

/**
 * Map variables to their clause occurrences
 */
function _mapVariableOccurrences(
  patternClauses: DatalogQueryWhereClause[],
): Map<string, {clauseIndex: number; field: string}[]> {
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

  return variableToClause;
}

/**
 * Build JOIN conditions from shared variables
 */
function _buildJoinConditions(
  variableToClause: Map<string, {clauseIndex: number; field: string}[]>,
): string[] {
  const joinConditions: string[] = [];

  for (const occurrences of variableToClause.values()) {
    if (occurrences.length > 1) {
      for (let i = 1; i < occurrences.length; i++) {
        const prev = occurrences[i - 1];
        const curr = occurrences[i];
        if (!prev || !curr) continue;

        const prevAlias = `d${prev.clauseIndex}_active`;
        const currAlias = `d${curr.clauseIndex}_active`;

        const {prevExpr, currExpr} = _castExprForJoin(prevAlias, prev.field, currAlias, curr.field);

        joinConditions.push(`${prevExpr} = ${currExpr}`);
      }
    }
  }

  return joinConditions;
}

/**
 * Build JOIN clause for a specific table alias
 */
function _buildJoinClauseForAlias(
  index: number,
  patternClauses: DatalogQueryWhereClause[],
  joinConditions: string[],
): string {
  const alias = `d${index}_active`;
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
      if (otherIndex < index) {
        if (rightAlias === alias) {
          conditions.push(`${parts[1].trim()} = ${parts[0].trim()}`);
        } else {
          conditions.push(joinCond);
        }
      }
    }
  }

  if (conditions.length > 0) {
    return `JOIN ${alias} ON ${conditions.join(' AND ')}`;
  }
  // If no explicit JOIN conditions found, try to join to the previous table
  const prevAlias = `d${index - 1}_active`;
  const currentClause = patternClauses[index];
  const prevClause = patternClauses[index - 1];
  if (currentClause && prevClause && isQueryPattern(currentClause) && isQueryPattern(prevClause)) {
    const currE = currentClause.e;
    const prevE = prevClause.e;
    if (isVariable(currE) && isVariable(prevE) && currE === prevE) {
      return `JOIN ${alias} ON ${prevAlias}.e = ${alias}.e`;
    }
    return `CROSS JOIN ${alias}`;
  }
  return `CROSS JOIN ${alias}`;
}

// ============================================================================
// Low-Level Utility Functions
// ============================================================================

/**
 * Build SELECT columns for empty find clause
 */
function _buildSelectColumnsEmpty(
  patternClauses: DatalogQueryWhereClause[],
  variableToColumn: Map<string, string>,
  selectColumns: string[],
): void {
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
}

/**
 * Build SELECT columns for non-empty find clause
 */
function _buildSelectColumnsNonEmpty(
  query: DatalogQuery,
  patternClauses: DatalogQueryWhereClause[],
  variableToColumn: Map<string, string>,
  selectColumns: string[],
  groupByColumns: string[],
  params: unknown[],
): void {
  for (const [outputKey, expr] of Object.entries(query.find)) {
    switch (expr.t) {
      case 'identity':
        _buildVariableColumn(
          expr,
          outputKey,
          patternClauses,
          variableToColumn,
          selectColumns,
          groupByColumns,
          params,
        );
        break;
      default:
        _buildAggregationColumn(expr, expr.c, outputKey, variableToColumn, selectColumns);
        break;
    }
  }
}

/**
 * Build aggregation SELECT column
 */
function _buildAggregationColumn(
  expr: DatalogQueryFindVariable,
  varName: string,
  outputKey: string,
  variableToColumn: Map<string, string>,
  selectColumns: string[],
): void {
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
}

/**
 * Build variable SELECT column
 */
function _buildVariableColumn(
  expr: unknown,
  outputKey: string,
  patternClauses: DatalogQueryWhereClause[],
  variableToColumn: Map<string, string>,
  selectColumns: string[],
  groupByColumns: string[],
  params: unknown[],
): void {
  let varName: string;
  if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
    varName = expr[0];
  } else if (typeof expr === 'string') {
    varName = expr;
  } else if (
    typeof expr === 'object' &&
    expr !== null &&
    't' in expr &&
    'c' in expr &&
    expr.t === 'identity' &&
    typeof expr.c === 'string'
  ) {
    // Handle structured find format: {t: 'identity', c: '?x'}
    varName = expr.c;
  } else {
    return;
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
    } else {
      // Variable not found in variableToColumn - check pattern clauses for literal value
      // This handles cases where a hook modifies the WHERE clause to use literals
      // but the find clause still references the variable (e.g., e: 1 in WHERE, e: ['?e'] in find)
      const literal = _findLiteralInPatterns(varName, patternClauses);
      if (literal !== undefined) {
        // Use the literal value in SELECT
        if (typeof literal === 'string') {
          params.push(literal);
          selectColumns.push(`? AS "${outputKey}"`);
        } else {
          params.push(JSON.stringify(literal));
          selectColumns.push(`?::jsonb AS "${outputKey}"`);
        }
      }
    }
  }
}

/**
 * Find literal value in pattern clauses
 */
function _findLiteralInPatterns(
  varName: string,
  patternClauses: DatalogQueryWhereClause[],
): Value | Attribute | EntityId | undefined {
  for (const clause of patternClauses) {
    if (!clause || !isQueryPattern(clause)) continue;
    // Map common variable names to their field positions
    if (varName === '?e' && !isVariable(clause.e)) {
      return clause.e as EntityId;
    }
    if (varName === '?a' && !isVariable(clause.a)) {
      return clause.a as Attribute;
    }
    if (varName === '?v' && clause.v !== undefined && !isVariable(clause.v)) {
      return clause.v as Value;
    }
  }
  return undefined;
}

/**
 * Add predicate condition to conditions array
 */
function _addPredicateCondition(
  predicate: unknown[],
  variableToColumn: Map<string, string>,
  predicateConditions: string[],
  params: unknown[],
): void {
  const [op, varName, value] = predicate;
  if (typeof varName !== 'string' || !varName.startsWith('?')) {
    return;
  }

  if (varName === '?tx') {
    if (op === '=') {
      params.push(value);
      predicateConditions.push('d0_active.tx = ?');
    } else if (op === '<=') {
      params.push(value);
      predicateConditions.push('d0_active.tx <= ?');
    }
    return;
  }

  if (varName === '?op') {
    if (op === '=') {
      params.push(value);
      predicateConditions.push('d0_active.op = ?');
    }
    return;
  }

  const columnRef = variableToColumn.get(varName);
  if (!columnRef) {
    return;
  }

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

/**
 * Handle type casting for JOIN conditions
 */
function _castExprForJoin(
  prevAlias: string,
  prevField: string,
  currAlias: string,
  currField: string,
): {prevExpr: string; currExpr: string} {
  // Handle type casting: v is jsonb, e and a are text
  let prevExpr = `${prevAlias}.${prevField}`;
  let currExpr = `${currAlias}.${currField}`;

  if (prevField === 'v' && (currField === 'e' || currField === 'a')) {
    prevExpr = `${prevAlias}.v::text`;
  } else if ((prevField === 'e' || prevField === 'a') && currField === 'v') {
    currExpr = `${currAlias}.v::text`;
  } else if (prevField === 'v' && currField === 'v') {
    prevExpr = `${prevAlias}.v::text`;
    currExpr = `${currAlias}.v::text`;
  }

  return {prevExpr, currExpr};
}
