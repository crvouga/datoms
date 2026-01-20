import {describe, expect, test} from 'bun:test';
import {createTmdbClient} from './index';
import {FetchHttpClient} from '../../lib/http-client';

describe('TmdbClient', () => {
  try {
    createTmdbClient(new FetchHttpClient());
  } catch {
    console.error('Skipping tests because TmdbClient is not initialized');
    return;
  }
  const client = createTmdbClient(new FetchHttpClient());

  test('discoverMovies', async () => {
    const result = await client.discoverMovies({page: 1});
    expect(result?.results).toBeInstanceOf(Array);
  });
});
