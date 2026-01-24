/**
 * Movie data structure from TMDB API.
 * @see {@link https://developer.themoviedb.org/reference/movie-details TMDB Movie Details API}
 * @see {@link https://developer.themoviedb.org/docs/getting-started/introduction TMDB API Documentation}
 */
export interface Movie {
  id: number;
  title: string;
  overview: string;
  release_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count: number;
  [key: string]: unknown;
}
