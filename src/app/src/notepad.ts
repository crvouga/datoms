import type {DatomDatabase} from '../../datom-database';

export const notepad = async (db: DatomDatabase) => {
  // Query to get image configuration specifically
  const imageConfig = await db.query({
    find: {
      'base_url': ['?base_url'],
      'secure_base_url': ['?secure_base_url'],
      'poster_size': ['?poster_size'],
      'backdrop_size': ['?backdrop_size'],
    },
    where: [
      {
        e: '?config',
        a: 'tmdb.config/images.base_url',
        v: '?base_url',
      },
      {
        e: '?config',
        a: 'tmdb.config/images.secure_base_url',
        v: '?secure_base_url',
      },
      {
        e: '?config',
        a: 'tmdb.config/images.poster_sizes',
        v: '?poster_size',
      },
      {
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
