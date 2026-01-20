export const TMDB_MOVIE_ID = 'tmdb.movie/id';
export const TMDB_MOVIE_TITLE = 'tmdb.movie/title';

export const tmdbPrefixKey = (entity: 'movie' | 'tv' | 'person', key: string) =>
  `tmdb.${entity}/${key}`;
