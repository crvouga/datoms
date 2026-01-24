import type {HttpClient} from '../../lib/http-client';
import type {Movie} from './types';

type Nullish<T> = T extends object
  ?
      | {
          [K in keyof T]?: Nullish<T[K]> | null | undefined;
        }
      | null
      | undefined
  : T | null | undefined;

/**
 * Response structure for the discover movies endpoint.
 * @see {@link https://developer.themoviedb.org/reference/discover-movie TMDB Discover Movie API}
 */
export interface DiscoverMoviesResponse {
  page: number;
  results: Movie[];
  total_pages: number;
  total_results: number;
}

/**
 * Discover movies by different types of data like average rating, number of votes, genres and certifications.
 * @param httpClient - HTTP client for making API requests
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
export async function discoverMovies(
  httpClient: HttpClient,
  params?: {
    page?: number;
    sort_by?: string;
    with_genres?: string;
    primary_release_year?: number;
    'primary_release_date.gte'?: string;
    'primary_release_date.lte'?: string;
    [key: string]: string | number | undefined;
  },
): Promise<Nullish<DiscoverMoviesResponse>> {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!value) continue;
    searchParams.append(key, String(value));
  }
  const queryString = searchParams.toString();
  // Pass relative path (baseURL ends with / so this will be appended correctly)
  const path = `discover/movie${queryString ? `?${queryString}` : ''}`;
  return httpClient.get<Nullish<DiscoverMoviesResponse>>(path);
}
