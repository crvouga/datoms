import type {DatomDatabase, DatomInput, Logger} from '../../../datom-database';
import {datoms, value} from '../../../datoms';
import {mapKeys} from '../lib/map-keys';
import {tmdbNamespace} from './tmdb';
import type {TmdbClient} from './tmdb-client';

export class TmdbLoader {
  private shouldStop = false;

  constructor(
    private readonly tmdbClient: TmdbClient,
    private readonly db: DatomDatabase,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.shouldStop = false;
    this.logger.info('Starting TMDB loader');
    this.loadConfiguration().catch(error => {
      this.logger.error('TMDB configuration loader failed', {
        error: this.formatError(error),
      });
    });
    this.discoverMovies().catch(error => {
      this.logger.error('TMDB loader failed', {
        error: this.formatError(error),
      });
    });
  }

  stop(): void {
    this.shouldStop = true;
    this.logger.info('Stopping TMDB loader');
  }

  private formatError(error: unknown): {message: string; stack?: string} {
    return {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  private async loadConfiguration(): Promise<void> {
    this.logger.info('Loading TMDB configuration');
    const startTime = Date.now();

    // Load API configuration (images, etc.)
    const config = await this.tmdbClient.getConfiguration();
    if (config) {
      const configDatoms = datoms(
        {
          e: () => tmdbNamespace('config', 'config'),
        },
        [mapKeys(config, key => tmdbNamespace('config', key))],
      ).flatMap((datom): DatomInput[] => {
        // Handle nested image configuration
        if (datom.a === 'tmdb.config/images' && typeof datom.v === 'object' && datom.v !== null) {
          const images = datom.v as Record<string, unknown>;
          return Object.entries(images).flatMap(([key, val]): DatomInput[] => {
            if (Array.isArray(val)) {
              return val.map(
                (item): DatomInput => ({
                  a: tmdbNamespace('config', `images.${key}`),
                  v: value(item),
                  op: true,
                  e: datom.e,
                }),
              );
            }
            return [
              {
                a: tmdbNamespace('config', `images.${key}`),
                v: value(val),
                op: true,
                e: datom.e,
              },
            ];
          });
        }
        // Handle change_keys array
        if (datom.a === 'tmdb.config/change_keys' && Array.isArray(datom.v)) {
          return datom.v.map(
            (changeKey): DatomInput => ({
              a: 'tmdb.config/change_key',
              v: value(changeKey),
              op: true,
              e: datom.e,
            }),
          );
        }
        return [datom];
      });
      await this.db.transact(configDatoms, {createdBy: 'tmdb-loader'});
    }

    // Load countries
    const countries = await this.tmdbClient.getCountries();
    if (countries) {
      const countryDatoms = datoms(
        {
          e: c => tmdbNamespace('country', c.iso_3166_1?.toString() ?? ''),
        },
        countries.map(c => mapKeys(c, key => tmdbNamespace('country', key))),
      );
      await this.db.transact(countryDatoms, {createdBy: 'tmdb-loader'});
    }

    // Load languages
    const languages = await this.tmdbClient.getLanguages();
    if (languages) {
      const languageDatoms = datoms(
        {
          e: l => tmdbNamespace('language', l.iso_639_1?.toString() ?? ''),
        },
        languages.map(l => mapKeys(l, key => tmdbNamespace('language', key))),
      );
      await this.db.transact(languageDatoms, {createdBy: 'tmdb-loader'});
    }

    // Load primary translations
    const primaryTranslations = await this.tmdbClient.getPrimaryTranslations();
    if (primaryTranslations && Array.isArray(primaryTranslations)) {
      const translationDatoms = primaryTranslations.map(
        (lang): DatomInput => ({
          e: tmdbNamespace('config', 'primary_translations'),
          a: 'tmdb.config/primary_translation',
          v: value(lang),
          op: true,
        }),
      );
      await this.db.transact(translationDatoms, {createdBy: 'tmdb-loader'});
    }

    // Load timezones
    const timezones = await this.tmdbClient.getTimezones();
    if (timezones) {
      const timezoneDatoms = timezones.flatMap(tz => {
        if (!tz) return [];
        const entityId = tmdbNamespace('country', tz.iso_3166_1?.toString() ?? '');
        return (tz.zones ?? []).map(
          (zone): DatomInput => ({
            e: entityId,
            a: 'tmdb.country/timezone',
            v: value(zone),
            op: true,
          }),
        );
      });
      await this.db.transact(timezoneDatoms, {createdBy: 'tmdb-loader'});
    }

    this.logger.info('TMDB configuration loaded', {
      countries: countries?.length ?? 0,
      languages: languages?.length ?? 0,
      primaryTranslations: primaryTranslations?.length ?? 0,
      durationMs: Date.now() - startTime,
    });
  }

  private async discoverMovies(): Promise<void> {
    this.logger.info('Starting movie discovery');
    let page = 1;
    let totalMoviesProcessed = 0;
    let totalPages = Number.POSITIVE_INFINITY;
    while (!this.shouldStop && page < totalPages) {
      page++;
      await this.delay(0);
      const startTime = Date.now();

      const response = await this.tmdbClient.discoverMovies({page});

      page = response?.page ?? 0;
      totalPages = response?.total_pages ?? 0;

      const movies =
        response?.results?.map(m => mapKeys(m, key => tmdbNamespace('movie', key))) ?? [];

      const movieDatoms = datoms(
        {
          e: m => tmdbNamespace('movie', m['tmdb.movie/id']?.toString() ?? ''),
        },
        movies,
      ).flatMap((datom): DatomInput[] => {
        if (datom.a !== 'tmdb.movie/genre_ids') return [datom];

        const genreIds: unknown = typeof datom.v === 'string' ? JSON.parse(datom.v) : datom.v;
        if (!Array.isArray(genreIds)) return [];

        return genreIds.map(
          (genreId): DatomInput => ({
            a: 'tmdb.movie/genre_id',
            v: value(genreId),
            op: true,
            e: datom.e,
          }),
        );
      });
      await this.db.transact(movieDatoms, {createdBy: 'tmdb-loader'});
      totalMoviesProcessed += movies.length;
      this.logger.info('Page processed', {
        page,
        movies: movies.length,
        total: totalMoviesProcessed,
        durationMs: Date.now() - startTime,
      });
    }
    this.logger.info(this.shouldStop ? 'Movie discovery stopped' : 'Movie discovery completed', {
      pages: page - 1,
      totalMovies: totalMoviesProcessed,
    });
    this.logger.info('TMDB loader completed successfully');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
