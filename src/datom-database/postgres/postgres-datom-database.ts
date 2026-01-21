/**
 * PostgreSQL database implementation
 * Accepts a SqlConnection interface for PostgreSQL-compatible databases
 */

import type {DatalogQuery, DatalogQueryFindVariable, QueryClause} from '../../datalog/datalog.js';

import type {Attribute, Datom, DatomInput, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {SQLDatabase} from '../../sql-database/sql-database.js';
import type {DatabaseRow} from '../../sql-database/types.js';
import type {Logger, Transaction} from '../../types.js';

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
  type DatomsReadContext,
  type WriteContext,
  type WriteResult,
} from '../hook/hook.js';
import {applyAggregations} from '../in-memory/aggregations/computation.js';
import {parseAggregation} from '../in-memory/aggregations/parser.js';
import {isQueryPattern, isVariable, stripQuestionMark} from '../shared/datalog-helpers.js';
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
import {aggregationToSQL, checkSQLAggregations} from './aggregations/helpers.js';

/**
 * Configuration for PostgreSQL maintenance operations
 */
export interface PostgreSQLMaintenanceConfig {
  /** Enable maintenance (default: false) */
  enabled?: boolean;
  /** Interval in milliseconds for periodic execution (required if enabled) */
  intervalMs?: number;
  /** Run maintenance immediately on start (default: true) */
  runImmediately?: boolean;
}

/**
 * Metadata for a single SQL query execution
 */
interface SQLQueryMetadata {
  sql: string;
  rowCount: number;
  durationMs: number;
  queryPlan?: string;
}

/**
 * Format SQL query with parameters substituted for display purposes
 * Converts ? placeholders to actual values, properly escaped
 */
function formatSQLWithParams(sql: string, params: unknown[]): string {
  if (!params || params.length === 0) {
    return sql;
  }

  let paramIndex = 0;
  return sql.replace(/\?/g, () => {
    if (paramIndex >= params.length) {
      return '?';
    }
    const param = params[paramIndex++];

    // Handle null/undefined
    if (param === null || param === undefined) {
      return 'NULL';
    }

    // Handle numbers
    if (typeof param === 'number') {
      return String(param);
    }

    // Handle booleans
    if (typeof param === 'boolean') {
      return param ? 'true' : 'false';
    }

    // Handle strings
    if (typeof param === 'string') {
      // Check if it's a JSONB value (used for v column)
      // JSONB values are stringified JSON that need ::jsonb cast
      if (param.startsWith('{') || param.startsWith('[')) {
        try {
          // Validate it's valid JSON
          JSON.parse(param);
          // Escape single quotes and add jsonb cast
          const escaped = param.replace(/'/g, "''");
          return `'${escaped}'::jsonb`;
        } catch {
          // Not valid JSON, treat as regular string
          const escaped = param.replace(/'/g, "''");
          return `'${escaped}'`;
        }
      }
      // Regular string - escape single quotes and wrap in quotes
      const escaped = param.replace(/'/g, "''");
      return `'${escaped}'`;
    }

    // For other types, stringify and escape
    const stringified = String(param);
    const escaped = stringified.replace(/'/g, "''");
    return `'${escaped}'`;
  });
}

/**
 * Check if query can use pivot optimization (multiple attributes on same entity)
 */
function canUsePivotOptimization(clauses: QueryClause[]): boolean {
  if (clauses.length < 2) return false;

  // Check if all clauses query the same entity variable
  let sharedEntityVar: string | null = null;
  const attributeVars = new Set<string>();
  const boundAttributes = new Set<string>();

  for (const clause of clauses) {
    if (!clause || !isQueryPattern(clause)) return false;

    const {e: entityVal, a: attributeVal} = clause;

    // Entity must be a variable (not bound)
    if (!isVariable(entityVal)) return false;
    const entityVar = entityVal as string;

    // All clauses must share the same entity variable
    if (sharedEntityVar === null) {
      sharedEntityVar = entityVar;
    } else if (sharedEntityVar !== entityVar) {
      return false;
    }

    // Attribute must be bound (not a variable)
    if (!isVariable(attributeVal)) {
      boundAttributes.add(String(attributeVal));
    } else {
      attributeVars.add(attributeVal as string);
    }
  }

  // Need at least 2 bound attributes to benefit from pivot
  return boundAttributes.size >= 2;
}

/**
 * Convert a DatalogQuery to PostgreSQL SQL
 * Returns the SQL string and parameter array
 */
function datalogToPostgresSQL(
  query: DatalogQuery,
  tableName = 'datoms',
): {sql: string; params: unknown[]} {
  const clauses = query.where;
  const params: unknown[] = [];

  // Check if we can use pivot optimization
  const usePivot = canUsePivotOptimization(clauses);

  if (usePivot) {
    // Build SQL using pivot optimization
    // Collect all attributes and map them to their value variables or bound values
    const attributes: string[] = [];
    const attrToVar: Map<string, string> = new Map();
    const attrToBoundValue: Map<string, Value> = new Map();
    let entityVarName: string | null = null;

    for (const clause of clauses) {
      if (!clause || !isQueryPattern(clause)) {
        throw new Error('Only QueryPattern clauses are supported in pivot queries');
      }
      const {e: entityVal, a: attributeVal, v: valueVal} = clause;

      // Get entity variable (should be same for all clauses)
      if (isVariable(entityVal)) {
        if (entityVarName === null) {
          entityVarName = entityVal as string;
        }
      }

      // Collect bound attributes and their value variables or bound values
      if (!isVariable(attributeVal)) {
        const attr = String(attributeVal);
        if (!attributes.includes(attr)) {
          attributes.push(attr);
        }
        if (isVariable(valueVal)) {
          attrToVar.set(attr, valueVal as string);
        } else {
          // Bound value - track it for filtering
          let boundValue = valueVal as Value;
          if (boundValue === undefined) {
            boundValue = '__UNDEFINED__';
          }
          attrToBoundValue.set(attr, boundValue);
        }
      }
    }

    // Build single CTE with all attributes, filtering by bound values
    // For each attribute:
    // - If it has a bound value: (a = ? AND v = ?::jsonb)
    // - If it doesn't: a = ?
    // Combine with OR to include all matching datoms
    const attributeConditions: string[] = [];
    for (const attr of attributes) {
      if (attrToBoundValue.has(attr)) {
        // Bound value - filter by both attribute and value
        params.push(attr);
        // biome-ignore lint/style/noNonNullAssertion: boundValue is guaranteed to exist when attr is in map
        const boundValue = attrToBoundValue.get(attr)!;
        params.push(JSON.stringify(boundValue));
        attributeConditions.push('(a = ? AND v = ?::jsonb)');
      } else {
        // Variable value - just filter by attribute
        params.push(attr);
        attributeConditions.push('a = ?');
      }
    }

    // We need to include falseions in DISTINCT ON to correctly determine the latest state.
    // We filter by op AFTER DISTINCT ON. This ensures that if a datom was trueed then falseed, the falseion wins.
    const cte = `
      all_datoms AS (
        SELECT DISTINCT ON (e, a, v)
          e, a, v, tx, op
        FROM ${tableName}
        WHERE (${attributeConditions.join(' OR ')})
        ORDER BY e, a, v, tx DESC
      ),
      active_datoms AS (
        SELECT e, a, v, tx
        FROM all_datoms
        WHERE op = true
      )`;

    // Build pivot SELECT with conditional aggregation
    const pivotSelects: string[] = [];
    if (entityVarName) {
      const entityColName = stripQuestionMark(entityVarName);
      pivotSelects.push(`e AS "${entityColName}"`);
    }

    // Add CASE WHEN for each attribute->variable mapping
    // Use array_agg with FILTER instead of MAX because PostgreSQL's MAX() doesn't work on JSONB
    // FILTER ensures we only aggregate non-NULL values (matching attributes)
    // Since we're grouping by entity and each entity-attribute pair should have one value,
    // array_agg[1] will get that single value
    for (const [attr, varName] of attrToVar.entries()) {
      const varColName = stripQuestionMark(varName);
      pivotSelects.push(`(array_agg(v) FILTER (WHERE a = ?))[1] AS "${varColName}"`);
      params.push(attr);
    }

    // Build final SELECT columns from find clause
    const selectColumns: string[] = [];
    const findKeys = Object.keys(query.find);
    const varToColumn: Map<string, string> = new Map();

    // Map variables to their pivot column names (without ? prefix)
    if (entityVarName) {
      varToColumn.set(entityVarName, stripQuestionMark(entityVarName));
    }
    for (const varName of attrToVar.values()) {
      varToColumn.set(varName, stripQuestionMark(varName));
    }

    // Build SELECT columns
    for (const outputKey of findKeys) {
      const expr = query.find[outputKey];
      const agg = parseAggregation(expr);

      if (agg) {
        // Aggregation
        const varName = agg.variable;
        const colName = varToColumn.get(varName);
        if (colName) {
          const columnRef = `"${colName}"`;
          const sqlAgg = aggregationToSQL(expr, columnRef, outputKey);
          if (sqlAgg?.sql) {
            selectColumns.push(sqlAgg.sql);
          } else {
            selectColumns.push(`NULL AS "${outputKey}"`);
          }
        } else {
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

        const colName = varToColumn.get(varName);
        if (colName) {
          // Reference the column from the pivoted subquery
          const columnRef = `"${colName}"`;
          selectColumns.push(`${columnRef} AS "${outputKey}"`);
        }
      }
    }

    // Build GROUP BY clause for pivot subquery
    let groupByClause = '';
    if (entityVarName) {
      groupByClause = 'GROUP BY e';
    }

    // Build HAVING clause to ensure we have ALL required attributes
    // We need to check that:
    // 1. Each attribute that maps to a variable is present (not NULL)
    // 2. Each attribute with a bound value matches the expected value
    // This ensures entities without all required attributes are filtered out
    // Note: We must repeat the expression in HAVING, not reference the alias
    // The connection adapter will convert ? placeholders to $1, $2, etc.
    const havingConditions: string[] = [];

    // Check that attributes with variables are present
    for (const [attr] of attrToVar.entries()) {
      // Repeat the same array_agg expression used in SELECT to check for NULL
      // Add the attribute to params again (will be converted to positional params by adapter)
      params.push(attr);
      havingConditions.push('(array_agg(v) FILTER (WHERE a = ?))[1] IS NOT NULL');
    }

    // Check that attributes with bound values match the expected values
    for (const [attr, boundValue] of attrToBoundValue.entries()) {
      // Verify the pivoted value matches the bound value
      params.push(attr);
      params.push(JSON.stringify(boundValue));
      havingConditions.push('(array_agg(v) FILTER (WHERE a = ?))[1] = ?::jsonb');
    }

    const havingClause =
      havingConditions.length > 0 ? `HAVING ${havingConditions.join(' AND ')}` : '';

    // Build ORDER BY clause
    // For JSONB value columns, handle different types appropriately:
    // - Numbers: cast to numeric for proper numeric sorting
    // - Strings: extract text for alphabetical sorting
    // - Other types: convert to text
    // Use two ORDER BY expressions per variable:
    // 1. Numeric ordering (NULLS LAST for non-numeric values)
    // 2. Text ordering (NULLS LAST for numeric values)
    // This ensures numeric values are sorted numerically and text values alphabetically
    let orderByClause = '';
    if (query.orderBy && query.orderBy.length > 0) {
      const orderParts: string[] = [];
      for (const [variable, direction] of query.orderBy) {
        const colName = varToColumn.get(variable);
        if (colName) {
          const columnRef = `"${colName}"`;
          const dir = direction.toUpperCase();
          // First expression: numeric ordering (NULL for non-numeric values)
          orderParts.push(
            `CASE WHEN jsonb_typeof(${columnRef}::jsonb) = 'number' 
              THEN (${columnRef}::jsonb)::text::numeric
              ELSE NULL
            END ${dir} NULLS LAST`,
          );
          // Second expression: text ordering (NULL for numeric values)
          orderParts.push(
            `CASE WHEN jsonb_typeof(${columnRef}::jsonb) != 'number' 
              THEN CASE WHEN jsonb_typeof(${columnRef}::jsonb) = 'string' 
                THEN ${columnRef}::jsonb#>>'{}'
                ELSE ${columnRef}::jsonb::text
              END
              ELSE NULL
            END ${dir} NULLS LAST`,
          );
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
      WITH ${cte}
      SELECT ${selectColumns.join(', ')}
      FROM (
        SELECT ${pivotSelects.join(', ')}
        FROM active_datoms
        ${groupByClause}
        ${havingClause}
      ) AS pivoted
      ${orderByClause}
      ${limitClause}
    `;

    return {sql: sql.trim(), params};
  }

  // Build SQL using regular joins
  const ctes: string[] = [];
  const selectColumns: string[] = [];
  const joinConditions: string[] = [];

  // Build CTEs for each clause with deduplication using DISTINCT ON
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
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

    // We need to include falseions in DISTINCT ON to correctly determine the latest state.
    // We filter by op AFTER DISTINCT ON. This ensures that if a datom was trueed then falseed, the falseion wins.
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // PostgreSQL uses DISTINCT ON for deduplication
    const cte = `
      ${alias} AS (
        SELECT DISTINCT ON (e, a, v)
          e, a, v, tx, op
        FROM ${tableName}
        ${whereClause}
        ORDER BY e, a, v, tx DESC
      ),
      ${alias}_active AS (
        SELECT e, a, v, tx
        FROM ${alias}
        WHERE op = true
      )`;

    ctes.push(cte);
  }

  // Map variables to their column references for aggregations
  // Use first occurrence (lowest index) to ensure the table is definitely in FROM/JOIN
  // Use _active CTEs which filter to only trueions after DISTINCT ON
  const variableToColumn: Map<string, string> = new Map();
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!clause || !isQueryPattern(clause)) {
      continue;
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;
    const alias = `d${i}_active`;
    if (isVariable(entityVal)) {
      // Only set if not already mapped (prefer first occurrence)
      if (!variableToColumn.has(entityVal as string)) {
        variableToColumn.set(entityVal as string, `${alias}.e`);
      }
    }
    if (isVariable(attributeVal)) {
      // Only set if not already mapped (prefer first occurrence)
      if (!variableToColumn.has(attributeVal as string)) {
        variableToColumn.set(attributeVal as string, `${alias}.a`);
      }
    }
    if (isVariable(valueVal)) {
      // Only set if not already mapped (prefer first occurrence)
      if (!variableToColumn.has(valueVal as string)) {
        variableToColumn.set(valueVal as string, `${alias}.v`);
      }
    }
  }

  // Build JOIN conditions based on shared variables
  const variableToClause: Map<string, {clauseIndex: number; field: string}[]> = new Map();

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
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
  // Use _active CTEs which filter to only trueions after DISTINCT ON
  for (const occurrences of variableToClause.values()) {
    if (occurrences.length > 1) {
      for (let i = 1; i < occurrences.length; i++) {
        const prev = occurrences[i - 1];
        const curr = occurrences[i];
        if (!prev || !curr) continue;
        const prevAlias = `d${prev.clauseIndex}_active`;
        const currAlias = `d${curr.clauseIndex}_active`;

        // Handle type casting: v is jsonb, e and a are text
        // When comparing v with e or a, cast v to text
        let prevExpr = `${prevAlias}.${prev.field}`;
        let currExpr = `${currAlias}.${curr.field}`;

        if (prev.field === 'v' && (curr.field === 'e' || curr.field === 'a')) {
          // v (jsonb) = e/a (text): cast v to text
          prevExpr = `${prevAlias}.v::text`;
        } else if ((prev.field === 'e' || prev.field === 'a') && curr.field === 'v') {
          // e/a (text) = v (jsonb): cast v to text
          currExpr = `${currAlias}.v::text`;
        } else if (prev.field === 'v' && curr.field === 'v') {
          // v (jsonb) = v (jsonb): cast both to text for comparison
          prevExpr = `${prevAlias}.v::text`;
          currExpr = `${currAlias}.v::text`;
        }

        joinConditions.push(`${prevExpr} = ${currExpr}`);
      }
    }
  }

  // Build aggregation SELECT columns
  // First check if we have any aggregations
  const hasAggregations = Object.values(query.find).some(expr => parseAggregation(expr));
  const groupByColumns: string[] = [];
  const findKeys = Object.keys(query.find);
  for (const outputKey of findKeys) {
    const expr = query.find[outputKey];
    const agg = parseAggregation(expr);

    if (agg) {
      // This is an aggregation - convert to SQL
      const varName = agg.variable;
      const columnRef = variableToColumn.get(varName);
      if (columnRef) {
        const sqlAgg = aggregationToSQL(expr, columnRef, outputKey);
        if (sqlAgg?.sql) {
          selectColumns.push(sqlAgg.sql);
        } else {
          // Unsupported aggregation - return null
          selectColumns.push(`NULL AS "${outputKey}"`);
        }
      } else {
        // Variable not found - return null
        selectColumns.push(`NULL AS "${outputKey}"`);
      }
    } else {
      // Regular variable - include in SELECT
      let varName: string;
      if (Array.isArray(expr) && expr.length === 1 && typeof expr[0] === 'string') {
        varName = expr[0];
      } else if (typeof expr === 'string') {
        varName = expr;
      } else {
        continue;
      }

      const columnRef = variableToColumn.get(varName);
      if (columnRef) {
        selectColumns.push(`${columnRef} AS "${outputKey}"`);
        // Only add to GROUP BY if we have aggregations (required by SQL)
        if (hasAggregations) {
          groupByColumns.push(columnRef);
        }
      }
    }
  }

  // Build the final SQL query
  // Use _active CTEs which filter to only trueions after DISTINCT ON
  const cteClause = ctes.length > 0 ? `WITH ${ctes.join(', ')}` : '';
  const fromClause = 'FROM d0_active';

  // Build JOIN clauses
  const joinClauses: string[] = [];
  for (let i = 1; i < clauses.length; i++) {
    const alias = `d${i}_active`;
    const conditions: string[] = [];

    for (const joinCond of joinConditions) {
      const parts = joinCond.split(' = ');
      if (parts.length === 2 && parts[0] && parts[1]) {
        // Extract table aliases from both sides (handle type casting like ::text)
        // Match alias at the start, which may be followed by field access and type casts
        // Join conditions already use _active aliases
        const leftMatch = parts[0].trim().match(/^(d\d+)_active\./);
        const rightMatch = parts[1].trim().match(/^(d\d+)_active\./);

        if (!leftMatch || !rightMatch || !leftMatch[1] || !rightMatch[1]) continue;

        const leftAlias = `${leftMatch[1]}_active`;
        const rightAlias = `${rightMatch[1]}_active`;

        // Check if this condition involves the current alias
        if (leftAlias !== alias && rightAlias !== alias) {
          // Current alias not in this condition, skip
          continue;
        }

        // Determine which side is the current alias and which is the other
        const otherAlias = leftAlias === alias ? rightAlias : leftAlias;

        // Only include condition if the other table has already been joined
        // (i.e., has a lower index than the current table)
        // Extract index from alias like "d0_active" -> 0
        const otherIndexMatch = otherAlias.match(/^d(\d+)_active$/);
        // biome-ignore lint/style/noNonNullAssertion: match[1] is guaranteed to exist when match succeeds
        const otherIndex = otherIndexMatch ? Number.parseInt(otherIndexMatch[1]!) : -1;
        if (otherIndex < i) {
          // Other table is already joined, include this condition
          // Join conditions already use _active aliases, so use as-is
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
      // This handles cases where variables might not be properly tracked
      const prevAlias = `d${i - 1}_active`;
      // Try to find any shared variables between current and previous clause
      const currentClause = clauses[i];
      const prevClause = clauses[i - 1];
      if (
        currentClause &&
        prevClause &&
        isQueryPattern(currentClause) &&
        isQueryPattern(prevClause)
      ) {
        // Check if they share the same entity variable
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

  // Build ORDER BY clause
  // Use variableToColumn map to ensure we reference columns from tables that are definitely joined
  // For JSONB value columns (.v), handle different types appropriately:
  // - Numbers: cast to numeric for proper numeric sorting
  // - Strings: extract text for alphabetical sorting
  // - Other types: convert to text
  // Use two ORDER BY expressions per variable for JSONB columns:
  // 1. Numeric ordering (NULLS LAST for non-numeric values)
  // 2. Text ordering (NULLS LAST for numeric values)
  let orderByClause = '';
  if (query.orderBy && query.orderBy.length > 0) {
    const orderParts: string[] = [];
    for (const [variable, direction] of query.orderBy) {
      const columnRef = variableToColumn.get(variable);
      if (columnRef) {
        const dir = direction.toUpperCase();
        // Check if this is a value column (JSONB) by checking if it contains .v
        const isValueColumn = columnRef.includes('.v');
        if (isValueColumn) {
          // First expression: numeric ordering (NULL for non-numeric values)
          orderParts.push(
            `CASE WHEN jsonb_typeof(${columnRef}::jsonb) = 'number' 
              THEN (${columnRef}::jsonb)::text::numeric
              ELSE NULL
            END ${dir} NULLS LAST`,
          );
          // Second expression: text ordering (NULL for numeric values)
          orderParts.push(
            `CASE WHEN jsonb_typeof(${columnRef}::jsonb) != 'number' 
              THEN CASE WHEN jsonb_typeof(${columnRef}::jsonb) = 'string' 
                THEN ${columnRef}::jsonb#>>'{}'
                ELSE ${columnRef}::jsonb::text
              END
              ELSE NULL
            END ${dir} NULLS LAST`,
          );
        } else {
          orderParts.push(`${columnRef} ${dir}`);
        }
      }
    }
    if (orderParts.length > 0) {
      orderByClause = `ORDER BY ${orderParts.join(', ')}`;
    }
  }

  // Build GROUP BY clause if we have aggregations with non-aggregated columns
  let groupByClause = '';
  if (groupByColumns.length > 0) {
    groupByClause = `GROUP BY ${groupByColumns.join(', ')}`;
  }

  const limitClause = query.limit ? 'LIMIT ?' : '';
  if (query.limit) {
    params.push(query.limit);
  }

  const sql = `
    ${cteClause}
    SELECT ${selectColumns.join(', ')}
    ${fromClause}
    ${joinClause}
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
  private maintenanceIntervalId: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunning = false;
  private maintenanceConfig?: PostgreSQLMaintenanceConfig;
  private logger?: Logger;

  constructor({
    sqlDb,
    tableName = 'datoms',
    maintenanceConfig,
    logger,
  }: {
    sqlDb: SQLDatabase;
    tableName?: string;
    maintenanceConfig?: PostgreSQLMaintenanceConfig;
    logger?: Logger;
  }) {
    this.hooks = new HookEngine();
    this.sqlDb = sqlDb;
    this.tableName = tableName || 'datoms';
    this.maintenanceConfig = maintenanceConfig;
    this.logger = logger;
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

    // PostgreSQL-optimized indexes
    // Note: INCLUDE clause not used for PGLite compatibility (requires PostgreSQL 11+)
    const indexes = [
      // Composite index for entity+attribute queries (most common pattern)
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_e_a_tx ON ${this.tableName}(e, a, tx DESC)`,
      // Composite index for attribute+value queries
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_v_tx ON ${this.tableName}(a, v, tx DESC)`,
      // Partial index for op=true (most common case - only active datoms)
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_active ON ${this.tableName}(e, a, tx DESC) WHERE op = true`,
      // Optimized index for attribute-based queries (used by pivot optimization)
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_a_tx ON ${this.tableName}(a, tx DESC) WHERE op = true`,
      // GIN index for JSONB value queries (containment, key existence, etc.)
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_v_gin ON ${this.tableName} USING GIN (v)`,
      // Index on tx for transaction-based queries
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
    this.stopMaintenance();
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

  /**
   * Get query plan for a SQL query using EXPLAIN
   */
  private async _getQueryPlan(sql: string, params: unknown[]): Promise<string | undefined> {
    try {
      // Use EXPLAIN (FORMAT TEXT) to get a readable query plan
      const explainSql = `EXPLAIN (FORMAT TEXT) ${sql}`;
      const planRows = await this.sqlDb.query(explainSql, params);

      // Combine all plan rows into a single string
      if (planRows && planRows.length > 0) {
        return planRows
          .map((row: DatabaseRow) => {
            // PostgreSQL EXPLAIN returns the plan in a column named "QUERY PLAN"
            // but different adapters might return it differently
            const planText =
              (row as Record<string, unknown>)['QUERY PLAN'] ||
              (row as Record<string, unknown>)['query plan'] ||
              Object.values(row)[0];
            return String(planText);
          })
          .join('\n');
      }
      return undefined;
    } catch (error) {
      // If EXPLAIN fails, don't break the query - just return undefined
      // This can happen if the SQL is invalid or if EXPLAIN is not supported
      this.logger?.warn('Failed to get query plan', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
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
          reject(new QueryTimeoutError(options.timeoutMs ?? 0, options));
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

  private async _executeCurrentQuery(
    options: DatomsQuery,
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{datoms: Datom[]; sql: string}> {
    await this._ensureInitialized();

    // Note: Validation is handled by the base class query() method
    // This method is also called by queryInternal() which bypasses validation
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Build WHERE conditions - connection adapter converts ? to $1, $2, etc.
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

    // Use DISTINCT ON to get latest datom per (e, a, v) in SQL
    // This supports multi-valued attributes (multiple values per attribute)
    // PostgreSQL-specific: DISTINCT ON with ORDER BY for efficient latest-row-per-group
    const limitClause = options.limit ? 'LIMIT ?' : '';
    const offsetClause = options.offset !== undefined ? 'OFFSET ?' : '';

    // We need to include falseions in DISTINCT ON to correctly determine the latest state.
    // We filter by op AFTER DISTINCT ON. This ensures that if a datom was trueed then falseed, the falseion wins.
    const combinedWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Use DISTINCT ON (e, a, v) to support multi-valued attributes
    const distinctOnColumns = 'e, a, v';
    const orderByColumns = 'e, a, v, tx DESC';

    // Build the op filter for after DISTINCT ON
    // Default behavior: filter to only add datoms (exclude sub)
    let opFilterAfter = '';
    if (options.op === undefined || options.op === true) {
      opFilterAfter = 'WHERE op = true';
    } else if (options.op === false) {
      opFilterAfter = 'WHERE op = false';
    }

    const sql = `
      WITH latest_datoms AS (
        SELECT DISTINCT ON (${distinctOnColumns})
          e, a, v, tx, op
        FROM ${this.tableName}
        ${combinedWhereClause}
        ORDER BY ${orderByColumns}
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

    const queryStartTime = performance.now();
    const rows = await this.sqlDb.query(sql, params);
    const queryDuration = performance.now() - queryStartTime;

    if (sqlQueries) {
      const queryPlan = await this._getQueryPlan(sql, params);
      sqlQueries.push({
        sql: formatSQLWithParams(sql, params),
        rowCount: rows.length,
        durationMs: queryDuration,
        queryPlan,
      });
    }

    return {datoms: this._mapRowsToDatoms(rows), sql};
  }

  private async _executeAsOfQuery(
    options: DatomsQuery,
    txId: TransactionId,
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{datoms: Datom[]; sql: string}> {
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

    // Use DISTINCT ON (e, a) to deduplicate by entity-attribute pair
    // This keeps the latest value per attribute (asOf semantics)
    const sql = `
      SELECT DISTINCT ON (e, a)
        e, a, v, tx, op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY e, a, tx DESC
    `;

    // Filter to only add datoms after DISTINCT ON
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

    const queryStartTime = performance.now();
    const rows = await this.sqlDb.query(finalSql, params);
    const queryDuration = performance.now() - queryStartTime;

    if (sqlQueries) {
      const queryPlan = await this._getQueryPlan(finalSql, params);
      sqlQueries.push({
        sql: formatSQLWithParams(finalSql, params),
        rowCount: rows.length,
        durationMs: queryDuration,
        queryPlan,
      });
    }

    return {datoms: this._mapRowsToDatoms(rows), sql: finalSql};
  }

  private async _executeHistoryQuery(
    options: DatomsQuery,
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{datoms: Datom[]; sql: string}> {
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
    `.trim();

    if (options.limit) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const queryStartTime = performance.now();
    const rows = await this.sqlDb.query(sql, params);
    const queryDuration = performance.now() - queryStartTime;

    if (sqlQueries) {
      const queryPlan = await this._getQueryPlan(sql, params);
      sqlQueries.push({
        sql: formatSQLWithParams(sql, params),
        rowCount: rows.length,
        durationMs: queryDuration,
        queryPlan,
      });
    }

    return {datoms: this._mapRowsToDatoms(rows), sql};
  }

  private async _executeSinceQuery(
    options: DatomsQuery,
    txId: TransactionId,
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{datoms: Datom[]; sql: string}> {
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

    // Use DISTINCT ON (e, a, v) for normal deduplication
    const sql = `
      SELECT DISTINCT ON (e, a, v)
        e, a, v, tx, op
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY e, a, v, tx DESC
    `;

    // Filter to only add datoms after DISTINCT ON
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

    const queryStartTime = performance.now();
    const rows = await this.sqlDb.query(finalSql, params);
    const queryDuration = performance.now() - queryStartTime;

    if (sqlQueries) {
      const queryPlan = await this._getQueryPlan(finalSql, params);
      sqlQueries.push({
        sql: formatSQLWithParams(finalSql, params),
        rowCount: rows.length,
        durationMs: queryDuration,
        queryPlan,
      });
    }

    return {datoms: this._mapRowsToDatoms(rows), sql: finalSql};
  }

  private async _executeSpeculativeQuery(
    options: DatomsQuery,
    speculativeDatoms: Datom[],
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{datoms: Datom[]; sqlQueries: SQLQueryMetadata[]}> {
    await this._ensureInitialized();

    const accumulatedSql: SQLQueryMetadata[] = [];

    // For speculative queries, we need to merge base datoms with speculative changes
    // Get all base datoms (current state)
    const baseResult = await this._executeCurrentQuery({}, accumulatedSql);
    const baseDatoms = baseResult.datoms;

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
      // Default: only true
      results = results.filter(d => d.op === true);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit;
    const finalResults = results.slice(offset, limit ? offset + limit : undefined);

    // Accumulate SQL queries if provided
    if (sqlQueries) {
      sqlQueries.push(...accumulatedSql);
    }

    return {datoms: finalResults, sqlQueries: accumulatedSql};
  }

  /**
   * Helper method to map database rows to Datom objects
   * Reused across query methods
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
      // Handle both cases: already parsed or string that needs parsing
      let parsedValue: unknown = row.v;
      if (typeof row.v === 'string') {
        // Try to parse as JSON, but if it fails, use the string as-is
        // This handles cases where JSONB returns simple strings directly
        try {
          parsedValue = JSON.parse(row.v);
        } catch {
          // Not valid JSON, use as plain string
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
    // Extract context and viewConfig from query object
    const context = query.context;
    const viewConfig = query.viewConfig ?? {type: 'current'};
    return this._queryWithMetadataInternal(query, context, viewConfig);
  }

  /**
   * Execute a clause and return datoms (for hook support)
   */
  private async _executeClauseAsDatoms(clause: QueryClause): Promise<Datom[]> {
    if (!isQueryPattern(clause)) {
      throw new Error('Only QueryPattern clauses are supported');
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    const result = await this._executeCurrentQuery({
      e: entity,
      a: attribute,
      v: value,
      op: true,
    });
    return result.datoms;
  }

  /**
   * Execute a clause using filtered datoms from hooks
   */
  private async _executeClauseWithFilteredDatoms(
    clause: QueryClause,
    filteredDatoms: Datom[],
  ): Promise<Record<string, Value | Attribute>[]> {
    if (!isQueryPattern(clause)) {
      throw new Error('Only QueryPattern clauses are supported');
    }
    const {e: entityVal, a: attributeVal, v: valueVal} = clause;
    const entity = isVariable(entityVal) ? undefined : (entityVal as EntityId);
    const attribute = isVariable(attributeVal) ? undefined : (attributeVal as string);
    const value = isVariable(valueVal) ? undefined : (valueVal as Value);

    // Filter datoms based on clause
    let matchingDatoms = filteredDatoms;
    if (entity !== undefined) {
      matchingDatoms = matchingDatoms.filter(d => d.e === entity);
    }
    if (attribute !== undefined) {
      matchingDatoms = matchingDatoms.filter(d => d.a === attribute);
    }
    if (value !== undefined) {
      matchingDatoms = matchingDatoms.filter(d => JSON.stringify(d.v) === JSON.stringify(value));
    }

    // Map datom fields to variable names from the clause
    return matchingDatoms.map(datom => {
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
  }

  /**
   * Execute datalog query using SQL with aggregations
   */
  private async _executeDatalogWithSQL(
    query: DatalogQuery,
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{results: QueryResult; sql: string}> {
    // Use the extracted SQL building function
    const {sql, params} = datalogToPostgresSQL(query, this.tableName);

    const queryStartTime = performance.now();
    const rows = await this.sqlDb.query(sql, params);
    const queryDuration = performance.now() - queryStartTime;

    if (sqlQueries) {
      const queryPlan = await this._getQueryPlan(sql, params);
      sqlQueries.push({
        sql: formatSQLWithParams(sql, params),
        rowCount: rows.length,
        durationMs: queryDuration,
        queryPlan,
      });
    }

    // Convert SQL results back to QueryResult format
    // Note: Special handling for aggregation results (numeric strings)

    const results: Record<string, Value | Attribute>[] = rows.map((row: DatabaseRow) => {
      const result: Record<string, Value | Attribute> = {};
      for (const key of Object.keys(row)) {
        let value: unknown = row[key];
        // PostgreSQL stores values as JSONB, so parse them
        // But for aggregation results, they might already be numbers or strings
        if (typeof value === 'string') {
          // For numeric strings (aggregation results), convert directly
          if (/^-?\d+$/.test(value)) {
            const num = Number.parseInt(value, 10);
            if (!Number.isNaN(num)) {
              value = num;
            } else {
              // Try JSON parse for other string values
              try {
                value = JSON.parse(value);
              } catch {
                // Not valid JSON, keep as string
              }
            }
          } else {
            // Try JSON parse for non-numeric strings
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
          // For numeric strings (like aggregation results), try to convert to number first
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

    // For SQL queries with aggregations, the results already have output keys as column names
    // We just need to map them directly without calling applyAggregations again
    // (The project function would try to re-aggregate, but we've already done it in SQL)
    if (Object.keys(query.find).length === 0) {
      return {results, sql};
    }

    // Map results - they already have output keys as keys (from SQL aliases)
    const finalResults = results.map(row => {
      const projected: Record<string, Value | Attribute> = {};
      for (const outputKey of Object.keys(query.find)) {
        if (outputKey in row) {
          projected[outputKey] = row[outputKey];
        }
      }
      return projected;
    });
    return {results: finalResults, sql};
  }

  private async _getNextTransactionId(
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{txId: TransactionId; sql: string}> {
    // PostgreSQL-optimized: Use INSERT ... ON CONFLICT ... UPDATE ... RETURNING
    // This combines initialization, update, and retrieval into a single atomic operation
    // The ON CONFLICT ensures thread-safety, and RETURNING gets the new value in one query
    const sql = `
      INSERT INTO ${this.tableName}_tx (id, last_tx)
      VALUES (1, 0)
      ON CONFLICT (id) 
      DO UPDATE SET last_tx = ${this.tableName}_tx.last_tx + 1
      RETURNING last_tx
    `.trim();

    const queryStartTime = performance.now();
    const result = await this.sqlDb.query(sql);
    const queryDuration = performance.now() - queryStartTime;

    if (sqlQueries) {
      const queryPlan = await this._getQueryPlan(sql, []);
      sqlQueries.push({
        sql: formatSQLWithParams(sql, []),
        rowCount: result.length,
        durationMs: queryDuration,
        queryPlan,
      });
    }
    if (!result || result.length === 0) {
      throw new Error('Transaction counter row not found after update');
    }
    const row = result[0] as Record<string, unknown>;
    return {txId: Number(row.last_tx), sql};
  }

  private async _writeDatomsInternal(
    datoms: DatomInput[],
    tx: TransactionId,
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<{sql: string}> {
    if (datoms.length === 0) return {sql: ''};

    // Batch inserts to avoid PostgreSQL's parameter limit
    // Using batches of 199 datoms (199 * 5 params = 995 variables, safely under limit)
    const BATCH_SIZE = 199;
    const sqlStatements: string[] = [];

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

      const queryStartTime = performance.now();
      await this.sqlDb.execute(sql, params);
      const queryDuration = performance.now() - queryStartTime;

      sqlStatements.push(sql);

      if (sqlQueries) {
        // For INSERT operations, rowCount represents the number of datoms attempted to insert
        // Note: Actual inserted count may be less due to ON CONFLICT DO NOTHING
        const queryPlan = await this._getQueryPlan(sql, params);
        sqlQueries.push({
          sql: formatSQLWithParams(sql, params),
          rowCount: batch.length,
          durationMs: queryDuration,
          queryPlan,
        });
      }
    }

    return {sql: sqlStatements.join('; ')};
  }

  async _getLatestTransaction(): Promise<Transaction> {
    await this._ensureInitialized();
    const sql = `SELECT last_tx FROM ${this.tableName}_tx WHERE id = 1`;
    const result = await this.sqlDb.query(sql);
    if (!result || result.length === 0) {
      // No transactions yet
      return {txId: 0, datoms: [], meta: undefined};
    }
    const row = result[0] as Record<string, unknown>;
    const txId = Number(row.last_tx);

    // Get all datoms for this transaction using history view
    const historyResult = await this._executeHistoryQuery({tx: txId});

    return {
      txId,
      datoms: historyResult.datoms,
      meta: undefined, // Metadata is not persisted in PostgreSQL implementation
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
    // Only processes (e, a) pairs that have more than retentionCount datoms
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
    sqlQueries?: SQLQueryMetadata[],
  ): Promise<DatomsResultEnvelope> {
    await this._ensureInitialized();

    const startTime = performance.now();
    const metadata: Record<string, unknown> = {};

    // Create datoms read context for hooks
    const {db: _, query: __, ...restContext} = options.context || {};
    const ctx: DatomsReadContext = {
      ...restContext,
      db: this,
      query: options,
    };

    // Run before-datoms-read hooks
    const beforeResult = await this.hooks.runBeforeDatomsRead(options, ctx);

    if (beforeResult.errors.length > 0) {
      throw new QueryError('Datoms query blocked by hooks', beforeResult.errors);
    }

    const modifiedOptions = beforeResult.query;

    let result: Datom[];
    const accumulatedSql: SQLQueryMetadata[] = sqlQueries || [];

    if (viewConfig.type === 'current') {
      const execResult = await this._executeCurrentQuery(modifiedOptions, accumulatedSql);
      result = execResult.datoms;
    } else if (viewConfig.type === 'asOf') {
      const execResult = await this._executeAsOfQuery(
        modifiedOptions,
        viewConfig.txId,
        accumulatedSql,
      );
      result = execResult.datoms;
    } else if (viewConfig.type === 'since') {
      const execResult = await this._executeSinceQuery(
        modifiedOptions,
        viewConfig.txId,
        accumulatedSql,
      );
      result = execResult.datoms;
    } else if (viewConfig.type === 'history') {
      const execResult = await this._executeHistoryQuery(modifiedOptions, accumulatedSql);
      result = execResult.datoms;
    } else if (viewConfig.type === 'speculative') {
      const execResult = await this._executeSpeculativeQuery(
        modifiedOptions,
        viewConfig.datoms,
        accumulatedSql,
      );
      result = execResult.datoms;
      accumulatedSql.push(...execResult.sqlQueries);
    } else {
      // TypeScript exhaustiveness check
      const _exhaustive: never = viewConfig;
      throw new Error(`Unknown view config type: ${(_exhaustive as ViewConfig).type}`);
    }

    // Run after-datoms-read hooks
    const afterResult = await this.hooks.runAfterDatomsRead(result, ctx);

    if (afterResult.errors.length > 0) {
      throw new QueryError('Datoms query blocked by after-read hooks', afterResult.errors);
    }

    const executionTime = performance.now() - startTime;

    if (accumulatedSql.length > 0) {
      metadata.sql = accumulatedSql;
    }
    metadata.executionTimeMs = executionTime;
    metadata.resultCount = afterResult.datoms.length;

    return {
      data: afterResult.datoms,
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
    const sqlQueries: SQLQueryMetadata[] = [];

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

    // Helper function to build QueryResult and run afterRead hooks
    const buildAndFilterQueryResult = async (
      buildResult: () => Promise<QueryResult<TFind>>,
      executionStrategy: string,
    ): Promise<QueryResultEnvelope<TFind>> => {
      const queryResult = await buildResult();

      // Run after-read hooks on QueryResult
      const afterResult = await this.hooks.runAfterRead(queryResult, ctx);

      if (afterResult.errors.length > 0) {
        throw new QueryError('Query blocked by after-read hooks', afterResult.errors);
      }

      const executionTime = performance.now() - startTime;
      metadata.executionTimeMs = executionTime;
      metadata.resultCount = afterResult.results.length;
      metadata.executionStrategy = executionStrategy;
      if (sqlQueries.length > 0) {
        metadata.sql = sqlQueries;
      }

      return {
        data: afterResult.results,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      };
    };

    // Check if we have aggregations - if so, use SQL query building
    const aggCheck = checkSQLAggregations(modifiedQuery.find);
    const hasAggs = aggCheck.hasAggregations;
    const allAggsSupported = aggCheck.allSupported;

    // For speculative views, always use in-memory approach
    if (viewConfig.type === 'speculative') {
      return buildAndFilterQueryResult(async () => {
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
          sqlQueries,
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
            sqlQueries,
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

        // Apply aggregations if needed
        let finalResult: QueryResult<TFind>;
        if (hasAggs) {
          finalResult = applyAggregations(projected, modifiedQuery.find) as QueryResult<TFind>;
        } else {
          finalResult = projected as QueryResult<TFind>;
        }

        // Apply ordering if specified
        if (modifiedQuery.orderBy) {
          finalResult.sort((a, b) => {
            for (const [variable, direction] of modifiedQuery.orderBy ?? []) {
              const key = stripQuestionMark(variable);
              const aVal = a[key];
              const bVal = b[key];
              if (aVal === undefined && bVal === undefined) return 0;
              if (aVal === undefined || aVal === null) return direction === 'asc' ? 1 : -1;
              if (bVal === undefined || bVal === null) return direction === 'asc' ? -1 : 1;
              if (aVal < bVal) return direction === 'asc' ? -1 : 1;
              if (aVal > bVal) return direction === 'asc' ? 1 : -1;
            }
            return 0;
          });
        }

        // Apply limit if specified
        if (modifiedQuery.limit !== undefined) {
          finalResult = finalResult.slice(0, modifiedQuery.limit);
        }

        return finalResult;
      }, 'in-memory-speculative');
    }

    // For non-speculative views, use the same logic as regular query() method
    // If we have unsupported aggregations, use in-memory approach
    if (hasAggs && !allAggsSupported) {
      return buildAndFilterQueryResult(async () => {
        // Use in-memory joins and aggregations
        const firstClause = modifiedQuery.where[0];
        if (!firstClause) {
          return [] as QueryResult<TFind>;
        }

        // Extract all datoms needed for query execution
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
              viewConfig,
            },
            viewConfig,
            sqlQueries,
          );

          for (const datom of clauseDatoms.data) {
            const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
            if (!allDatomsSet.has(key)) {
              allDatomsSet.add(key);
              allDatoms.push(datom);
            }
          }
        }

        const firstResults = await this._executeClauseWithFilteredDatoms(firstClause, allDatoms);

        let results = firstResults;
        for (let i = 1; i < modifiedQuery.where.length; i++) {
          const clause = modifiedQuery.where[i];
          if (!clause) continue;
          const clauseResults = await this._executeClauseWithFilteredDatoms(clause, allDatoms);
          results = joinResults(results, clauseResults, modifiedQuery.where.slice(0, i + 1));
        }

        // Apply aggregations in-memory
        const aggregated = applyAggregations(results, modifiedQuery.find);
        const projected = project(aggregated, modifiedQuery.find, modifiedQuery.where);

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

        let finalResult: QueryResult<TFind> = projected as QueryResult<TFind>;
        if (modifiedQuery.limit) {
          finalResult = finalResult.slice(0, modifiedQuery.limit) as QueryResult<TFind>;
        }

        return finalResult;
      }, 'in-memory-unsupported-aggregations');
    }

    // For multi-clause queries with all aggregations supported, use SQL query building
    if (modifiedQuery.where.length > 1 && hasAggs && allAggsSupported) {
      return buildAndFilterQueryResult(async () => {
        const sqlResult = await this._executeDatalogWithSQL(modifiedQuery, sqlQueries);
        return sqlResult.results as QueryResult<TFind>;
      }, 'sql-aggregations');
    }

    // For multi-clause queries without aggregations, use SQL execution if query qualifies
    if (modifiedQuery.where.length > 1 && !hasAggs) {
      // Check if query qualifies for pivot optimization
      const usePivot = canUsePivotOptimization(modifiedQuery.where);

      if (usePivot) {
        return buildAndFilterQueryResult(async () => {
          const sqlResult = await this._executeDatalogWithSQL(modifiedQuery, sqlQueries);
          return sqlResult.results as QueryResult<TFind>;
        }, 'sql-pivot');
      }

      // For regular multi-clause joins, use SQL execution
      return buildAndFilterQueryResult(async () => {
        const sqlResult = await this._executeDatalogWithSQL(modifiedQuery, sqlQueries);
        return sqlResult.results as QueryResult<TFind>;
      }, 'sql-joins');
    }

    // Now execute the query (no aggregations or single clause with supported aggregations)
    return buildAndFilterQueryResult(async () => {
      const firstClause = modifiedQuery.where[0];
      if (!firstClause) {
        return [] as QueryResult<TFind>;
      }

      // Extract all datoms needed for query execution
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
            viewConfig,
          },
          viewConfig,
          sqlQueries,
        );

        for (const datom of clauseDatoms.data) {
          const key = `${datom.e}|${datom.a}|${JSON.stringify(datom.v)}|${datom.tx}`;
          if (!allDatomsSet.has(key)) {
            allDatomsSet.add(key);
            allDatoms.push(datom);
          }
        }
      }

      const firstResults = await this._executeClauseWithFilteredDatoms(firstClause, allDatoms);

      let results = firstResults;
      for (let i = 1; i < modifiedQuery.where.length; i++) {
        const clause = modifiedQuery.where[i];
        if (!clause) continue;
        const clauseResults = await this._executeClauseWithFilteredDatoms(clause, allDatoms);
        results = joinResults(results, clauseResults, modifiedQuery.where.slice(0, i + 1));
      }

      const projected = project(results, modifiedQuery.find, modifiedQuery.where);

      if (modifiedQuery.orderBy) {
        // Map orderBy variables to output keys from find clause
        const variableToOutputKey = new Map<string, string>();
        for (const [outputKey, expr] of Object.entries(modifiedQuery.find)) {
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

        projected.sort((a, b) => {
          for (const [variable, direction] of modifiedQuery.orderBy ?? []) {
            // Map variable to output key, or fall back to stripped variable name
            const outputKey = variableToOutputKey.get(variable) ?? stripQuestionMark(variable);
            const aVal = a[outputKey];
            const bVal = b[outputKey];

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

      let finalResult: QueryResult<TFind> = projected as QueryResult<TFind>;
      if (modifiedQuery.limit) {
        finalResult = finalResult.slice(0, modifiedQuery.limit) as QueryResult<TFind>;
      }

      return finalResult;
    }, 'in-memory');
  }

  /**
   * Start periodic PostgreSQL maintenance (VACUUM ANALYZE)
   * Maintenance must be configured in constructor to use this method
   */
  startMaintenance(): void {
    if (!this.maintenanceConfig || !this.maintenanceConfig.enabled) {
      return;
    }

    if (this.maintenanceRunning) {
      this.logger?.warn('Maintenance already running', {
        event: 'postgres_maintenance_already_running',
      });
      return;
    }

    if (!this.maintenanceConfig.intervalMs) {
      this.logger?.warn('Maintenance enabled but intervalMs not provided', {
        event: 'postgres_maintenance_config_error',
      });
      return;
    }

    this.maintenanceRunning = true;

    this.logger?.info('Starting PostgreSQL maintenance', {
      event: 'postgres_maintenance_starting',
      intervalMs: this.maintenanceConfig.intervalMs,
      runImmediately: this.maintenanceConfig.runImmediately ?? true,
    });

    // Run immediately if configured
    if (this.maintenanceConfig.runImmediately !== false) {
      this.runMaintenance().catch(err => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger?.error('Initial maintenance run failed', {
          event: 'postgres_maintenance_error',
          error: errorMessage,
        });
      });
    }

    // Set up interval
    this.maintenanceIntervalId = setInterval(() => {
      this.runMaintenance().catch(err => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger?.error('Periodic maintenance execution failed', {
          event: 'postgres_maintenance_error',
          error: errorMessage,
        });
      });
    }, this.maintenanceConfig.intervalMs);
  }

  /**
   * Stop periodic PostgreSQL maintenance
   */
  stopMaintenance(): void {
    if (!this.maintenanceRunning) {
      return;
    }

    this.maintenanceRunning = false;

    if (this.maintenanceIntervalId !== null) {
      clearInterval(this.maintenanceIntervalId);
      this.maintenanceIntervalId = null;
    }

    this.logger?.info('Stopped PostgreSQL maintenance', {
      event: 'postgres_maintenance_stopped',
    });
  }

  /**
   * Check if maintenance is currently running
   */
  isMaintenanceRunning(): boolean {
    return this.maintenanceRunning;
  }

  /**
   * Execute PostgreSQL maintenance (VACUUM ANALYZE) once
   * This can be called manually or is called automatically by the interval
   */
  async runMaintenance(): Promise<void> {
    await this._executeVacuumAnalyze();
  }

  /**
   * Execute VACUUM ANALYZE on both tables
   * @private
   */
  private async _executeVacuumAnalyze(): Promise<void> {
    try {
      this.logger?.info('Running PostgreSQL maintenance...', {
        event: 'postgres_maintenance_start',
        tableName: this.tableName,
      });

      // VACUUM ANALYZE on both tables to reclaim storage and update statistics
      // VACUUM ANALYZE reclaims storage occupied by dead tuples and updates statistics
      await this.sqlDb.execute(`VACUUM ANALYZE ${this.tableName}`);
      await this.sqlDb.execute(`VACUUM ANALYZE ${this.tableName}_tx`);

      this.logger?.info('PostgreSQL maintenance completed', {
        event: 'postgres_maintenance_complete',
        tableName: this.tableName,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger?.error('PostgreSQL maintenance error', {
        event: 'postgres_maintenance_error',
        error: errorMessage,
        tableName: this.tableName,
      });
      // Don't throw - allow interval to continue
    }
  }
}
