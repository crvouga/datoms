import type {DatomDatabase} from '../../datom-database';

export const notepad = async (db: DatomDatabase) => {
  // Query to get image configuration specifically
  const imageConfig = await db.read({
    find: {
      base_url: {t: 'identity', c: '?base_url'},
      secure_base_url: {t: 'identity', c: '?secure_base_url'},
      poster_size: {t: 'identity', c: '?poster_size'},
      backdrop_size: {t: 'identity', c: '?backdrop_size'},
    },
    where: [
      {
        t: 'match',
        e: '?config',
        a: 'tmdb.config/images.base_url',
        v: '?base_url',
      },
      {
        t: 'match',
        e: '?config',
        a: 'tmdb.config/images.secure_base_url',
        v: '?secure_base_url',
      },
      {
        t: 'match',
        e: '?config',
        a: 'tmdb.config/images.poster_sizes',
        v: '?poster_size',
      },
      {
        t: 'match',
        e: '?config',
        a: 'tmdb.config/images.backdrop_sizes',
        v: '?backdrop_size',
      },
    ],
  });

  return {
    imageConfig,
  };
};
