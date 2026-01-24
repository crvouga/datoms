import type {HttpClient} from '../../lib/http-client';
import {discoverMovies as discoverMoviesImpl} from './discover-movies';

const BASE_URL = 'https://api.themoviedb.org/3';

// Re-export types
export type {DiscoverMoviesResponse} from './discover-movies';
export type {Movie} from './types';

/**
 * Client for interacting with The Movie Database (TMDB) API.
 * @see {@link https://developer.themoviedb.org/docs/getting-started/introduction TMDB API Documentation}
 * @see {@link https://developer.themoviedb.org/reference/discover-movie Discover Movie Endpoint}
 */
export class TmdbClient {
  private readonly httpClient: HttpClient;

  /**
   * Creates a new TMDB client instance.
   * @param httpClient - HTTP client for making API requests
   * @param tmdbApiReadAccessToken - TMDB API read access token (Bearer token)
   * @see {@link https://developer.themoviedb.org/docs/getting-started/introduction TMDB API Documentation}
   */
  constructor(httpClient: HttpClient, tmdbApiReadAccessToken: string) {
    // Ensure baseURL ends with / for proper path resolution
    const baseURL = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
    this.httpClient = httpClient.init(baseURL, {
      headers: {
        Authorization: `Bearer ${tmdbApiReadAccessToken}`,
      },
    });
  }

  /**
   * Discover movies by different types of data like average rating, number of votes, genres and certifications.
   * @param params - Query parameters for filtering and sorting movies
   * @param params.page - Specify which page to query (default: 1)
   * @param params.sort_by - Sort the results by a specified option
   * @param params.with_genres - Comma separated value of genre ids that you want to include in the results
   * @param params.primary_release_year - Filter by primary release year
   * @param params.primary_release_date.gte - Filter and only include movies that have a primary release date that is greater or equal to the specified value
   * @param params.primary_release_date.lte - Filter and only include movies that have a primary release date that is less than or equal to the specified value
   * @returns Promise resolving to discover movies response with nullish types
   * @see {@link https://developer.themoviedb.org/reference/discover-movie TMDB Discover Movie API}
   * @see {@link https://developer.themoviedb.org/docs/getting-started/discover TMDB Discover Documentation}
   */
  async discoverMovies(params?: Parameters<typeof discoverMoviesImpl>[1]) {
    return discoverMoviesImpl(this.httpClient, params);
  }
}

/**
 * Factory function to create a TMDB client instance.
 * Reads the API token from the TMDB_API_READ_ACCESS_TOKEN environment variable.
 * @returns A configured TmdbClient instance
 * @throws {Error} If TMDB_API_READ_ACCESS_TOKEN environment variable is not set
 * @see {@link https://developer.themoviedb.org/docs/getting-started/introduction TMDB API Documentation}
 */
export function createTmdbClient(httpClient: HttpClient): TmdbClient {
  const tmdbApiReadAccessToken = process.env.TMDB_API_READ_ACCESS_TOKEN;
  if (!tmdbApiReadAccessToken || tmdbApiReadAccessToken.trim() === '')
    throw new Error('TMDB_API_READ_ACCESS_TOKEN is not set');
  return new TmdbClient(httpClient, tmdbApiReadAccessToken);
}
