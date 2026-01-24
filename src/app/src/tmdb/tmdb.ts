import {namespaceKey} from '../../../namespace';

export const tmdbNamespace = (
  entity: 'movie' | 'tv' | 'person' | 'config' | 'country' | 'language',
  key: string,
) => namespaceKey(['tmdb'], entity, key);
