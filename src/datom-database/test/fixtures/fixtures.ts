import type {Fixture} from './fixture.js';
import {createFileSystemFixture} from './fixture/filesystem.js';
import {createHttpClientFixture} from './fixture/http-client.js';
import {createPGLiteFixture} from './fixture/pglite.js';
import {createPostgresFixture} from './fixture/postgres.js';

export const FAST_TESTS = process.env.FAST_TESTS === 'true';

export const FIXTURES: [string, () => Promise<Fixture>][] = [];
FIXTURES.push(['PostgreSQL', () => createPostgresFixture()]);
if (!FAST_TESTS) {
  FIXTURES.push(['PGLite', () => createPGLiteFixture()]);
  FIXTURES.push(['HTTP Client', () => createHttpClientFixture()]);
  FIXTURES.push(['FileSystem', () => createFileSystemFixture('test.csv')]);
}
