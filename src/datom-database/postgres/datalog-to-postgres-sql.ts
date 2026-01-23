/**
 * Converts DatalogQuery to PostgreSQL SQL
 */

import type {DatalogQuery, QueryClause} from '../../datalog/datalog.js';
import type {Attribute, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {ViewConfig} from '../views/view-config.js';
import {parseAggregation} from '../in-memory/aggregations/parser.js';
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
          } else {
            // Variable not found in variableToColumn - check pattern clauses for literal value
            // This handles cases where a hook modifies the WHERE clause to use literals
            // but the find clause still references the variable (e.g., e: 1 in WHERE, e: ['?e'] in find)
            let literal: Value | Attribute | EntityId | undefined;
            for (const clause of patternClauses) {
              if (!clause || !isQueryPattern(clause)) continue;
              // Map common variable names to their field positions
              if (varName === '?e' && !isVariable(clause.e)) {
                literal = clause.e as EntityId;
                break;
              }
              if (varName === '?a' && !isVariable(clause.a)) {
                literal = clause.a as Attribute;
                break;
              }
              if (varName === '?v' && clause.v !== undefined && !isVariable(clause.v)) {
                literal = clause.v as Value;
                break;
              }
            }
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
