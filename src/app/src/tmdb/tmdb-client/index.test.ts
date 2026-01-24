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

  test('getConfiguration', async () => {
    const result = await client.getConfiguration();
    expect(result?.images).toBeDefined();
    expect(result?.images?.base_url).toBeDefined();
    expect(result?.images?.secure_base_url).toBeDefined();
    expect(result?.images?.poster_sizes).toBeInstanceOf(Array);
  });

  test('getCountries', async () => {
    const result = await client.getCountries();
    expect(result).toBeInstanceOf(Array);
    if (result && result.length > 0) {
      expect(result[0]?.iso_3166_1).toBeDefined();
      expect(result[0]?.english_name).toBeDefined();
    }
  });

  test('getLanguages', async () => {
    const result = await client.getLanguages();
    expect(result).toBeInstanceOf(Array);
    if (result && result.length > 0) {
      expect(result[0]?.iso_639_1).toBeDefined();
      expect(result[0]?.english_name).toBeDefined();
      expect(result[0]?.name).toBeDefined();
    }
  });

  test('getPrimaryTranslations', async () => {
    const result = await client.getPrimaryTranslations();
    expect(result).toBeInstanceOf(Array);
    if (result && result.length > 0) {
      expect(typeof result[0]).toBe('string');
    }
  });

  test('getTimezones', async () => {
    const result = await client.getTimezones();
    expect(result).toBeInstanceOf(Array);
    if (result && result.length > 0) {
      expect(result[0]?.iso_3166_1).toBeDefined();
      expect(result[0]?.zones).toBeInstanceOf(Array);
    }
  });
});
