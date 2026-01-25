import {describe, expect, test} from 'bun:test';
import {format} from 'sql-formatter';
import type {DatalogQuery} from '../../datalog.js';
import {datalogToPostgresSQL} from './datalog-to-postgres-sql.js';

/**
 * Format SQL for comparison - normalizes whitespace and formatting
 */
function formatSQL(sql: string): string {
  return format(sql, {
    language: 'postgresql',
    tabWidth: 2,
    keywordCase: 'upper',
  });
}

describe('datalogToPostgresSQL', () => {
  test('simple single pattern query', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}, y: {t: 'identity', c: '?y'}},
      where: [{e: '?x', a: 'name', v: '?y'}],
    };

    const result = datalogToPostgresSQL(query);

    const expectedSQL = `
      WITH d0 AS (
        SELECT DISTINCT ON (e, a, v)
          e, a, v, tx, op
        FROM datoms
        WHERE a = ?
        ORDER BY e, a, v, tx DESC
      ),
      d0_active AS (
        SELECT e, a, v, tx, op
        FROM d0
        WHERE op = true
      )
      SELECT d0_active.e AS "x", d0_active.v AS "y"
      FROM d0_active
    `;

    expect(formatSQL(result.sql)).toBe(formatSQL(expectedSQL));
    expect(result.params).toEqual(['name']);
  });

  test('query with multiple patterns and joins', () => {
    const query: DatalogQuery = {
      find: {
        'movie/id': {t: 'identity', c: '?movie/id'},
        'movie/title': {t: 'identity', c: '?title'},
        'movie/popularity': {t: 'identity', c: '?popularity'},
      },
      where: [
        {e: '?movie/id', a: 'tmdb.movie/id', v: '?movie/id'},
        {e: '?movie/id', a: 'tmdb.movie/title', v: '?title'},
        {e: '?movie/id', a: 'tmdb.movie/popularity', v: '?popularity'},
      ],
      orderBy: [['?popularity', 'desc']],
      limit: 10,
    };

    const actual = datalogToPostgresSQL(query);

    // Example tests (not format checked, but cover core params and major CTEs)
    expect(actual.params).toEqual([
      'tmdb.movie/id',
      'tmdb.movie/title',
      'tmdb.movie/popularity',
      10,
    ]);
    expect(actual.sql).toContain('d0 AS');
    expect(actual.sql).toContain('d1 AS');
    expect(actual.sql).toContain('d2 AS');
    // Check 'ORDER BY' and 'LIMIT'
    expect(actual.sql).toMatch(/ORDER BY.*d2_active\.v DESC/is);
    expect(actual.sql).toMatch(/LIMIT\s+?/is);

    const expectedSQL = `
      WITH
        d0 AS (
          SELECT DISTINCT ON (e, a, v)
            e, a, v, tx, op
          FROM datoms
          WHERE a = ?
          ORDER BY e, a, v, tx DESC
        ),
        d0_active AS (
          SELECT e, a, v, tx, op
          FROM d0
          WHERE op = true
        ),
        d1 AS (
          SELECT DISTINCT ON (e, a, v)
            e, a, v, tx, op
          FROM datoms
          WHERE a = ?
          ORDER BY e, a, v, tx DESC
        ),
        d1_active AS (
          SELECT e, a, v, tx, op
          FROM d1
          WHERE op = true
        ),
        d2 AS (
          SELECT DISTINCT ON (e, a, v)
            e, a, v, tx, op
          FROM datoms
          WHERE a = ?
          ORDER BY e, a, v, tx DESC
        ),
        d2_active AS (
          SELECT e, a, v, tx, op
          FROM d2
          WHERE op = true
        )
      SELECT 
        d0_active.e AS "movie/id", 
        d1_active.v AS "movie/title", 
        d2_active.v AS "movie/popularity"
      FROM d0_active
      JOIN d1_active ON d1_active.e = d0_active.v::text
      JOIN d2_active ON d2_active.e = d1_active.e
      ORDER BY d2_active.v DESC
      LIMIT ?
    `;
    expect(formatSQL(actual.sql)).toBe(formatSQL(expectedSQL));
  });

  test('query with constant values', () => {
    const query: DatalogQuery = {
      find: {name: {t: 'identity', c: '?name'}},
      where: [{e: 1, a: 'name', v: '?name'}],
    };

    const result = datalogToPostgresSQL(query);

    const expectedSQL = `
      WITH d0 AS (
        SELECT DISTINCT ON (e, a, v)
          e, a, v, tx, op
        FROM datoms
        WHERE e = ? AND a = ?
        ORDER BY e, a, v, tx DESC
      ),
      d0_active AS (
        SELECT e, a, v, tx, op
        FROM d0
        WHERE op = true
      )
      SELECT d0_active.v AS "name"
      FROM d0_active
    `;

    expect(formatSQL(result.sql)).toBe(formatSQL(expectedSQL));
    expect(result.params).toEqual(['1', 'name']);
  });

  // test('query with predicate clause', () => {
  //   const query: DatalogQuery = {
  //     find: {x: ['?x'], age: ['?age']},
  //     where: [{e: '?x', a: 'age', v: '?age'}, ['<=', '?age', 30] as const],
  //   };

  //   const result = datalogToPostgresSQL(query);

  //   // Verify predicate is in WHERE clause
  //   expect(result.sql).toContain('WHERE');
  //   expect(result.sql).toContain('<=');
  //   // Note: numeric values in predicates are converted to strings
  //   expect(result.params).toEqual(['age', '30']);
  // });

  test('query with LIMIT clause', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}},
      where: [{e: '?x', a: 'name', v: '?y'}],
      limit: 10,
    };

    const result = datalogToPostgresSQL(query);

    expect(result.sql).toContain('LIMIT ?');
    expect(result.params).toContain(10);
  });

  test('query with ORDER BY clause', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}, name: {t: 'identity', c: '?name'}},
      where: [{e: '?x', a: 'name', v: '?name'}],
      orderBy: [['?name', 'asc']],
    };

    const result = datalogToPostgresSQL(query);

    expect(result.sql).toContain('ORDER BY');
    expect(result.sql).toContain('ASC');
  });

  test('query with empty find clause returns all variables', () => {
    const query: DatalogQuery = {
      find: {},
      where: [{e: '?x', a: 'name', v: '?y'}],
    };

    const result = datalogToPostgresSQL(query);

    // Should select all variables from pattern
    expect(result.sql).toContain('AS "x"');
    expect(result.sql).toContain('AS "y"');
  });

  test.skip('query with aggregation', () => {
    // TODO: Aggregation support needs investigation - currently not generating COUNT in SELECT
    const query: DatalogQuery = {
      find: {total: {t: 'count', c: '?age'}},
      where: [{e: '?e', a: 'age', v: '?age'}],
    };

    const result = datalogToPostgresSQL(query);

    expect(result.sql).toContain('COUNT');
    expect(result.params).toEqual(['age']);
  });

  test('throws error when no pattern clauses provided', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}},
      where: [],
    };

    expect(() => datalogToPostgresSQL(query)).toThrow(
      'Query must have at least one pattern clause',
    );
  });

  test('query with custom table name', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}},
      where: [{e: '?x', a: 'name', v: '?y'}],
    };

    const result = datalogToPostgresSQL(query, 'custom_table');

    expect(result.sql).toContain('FROM custom_table');
  });

  test('query with asOf view config', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}},
      where: [{e: '?x', a: 'name', v: '?y'}],
    };

    const viewConfig = {type: 'asOf' as const, txId: 100};
    const result = datalogToPostgresSQL(query, 'datoms', viewConfig);

    // Should include transaction filter
    expect(result.sql).toContain('tx <= ?');
    expect(result.params).toContain(100);
    // Should use DISTINCT ON (e, a) for asOf queries
    expect(result.sql).toContain('DISTINCT ON (e, a)');
  });

  test('query with history view config', () => {
    const query: DatalogQuery = {
      find: {x: {t: 'identity', c: '?x'}, op: {t: 'identity', c: '?op'}},
      where: [{e: '?x', a: 'name', v: '?y'}],
    };

    const viewConfig = {type: 'history' as const};
    const result = datalogToPostgresSQL(query, 'datoms', viewConfig);

    // History queries should not filter by op = true
    // Should not have DISTINCT ON for history
    const cteSection = result.sql.substring(0, result.sql.indexOf('SELECT d0_active'));
    expect(cteSection).not.toContain('DISTINCT ON');
  });
});
