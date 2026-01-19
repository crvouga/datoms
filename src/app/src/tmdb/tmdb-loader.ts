import type {
  DatomDatabase,
  DatomInput,
  Logger,
} from "../../../datom-database";
import { datoms, value } from "../../../datoms";
import { mapKeys } from "../lib/map-keys";
import { tmdbPrefixKey } from "./tmdb";
import type { TmdbClient } from "./tmdb-client";

export class TmdbLoader {
  private shouldStop = false;

  constructor(
    private readonly tmdbClient: TmdbClient,
    private readonly db: DatomDatabase,
    private readonly logger: Logger
  ) { }

  async start(): Promise<void> {
    this.shouldStop = false;
    this.logger.info("Starting TMDB loader");
    try {
      await this.discoverMovies();
    } catch (error) {
      this.logger.error("TMDB loader failed", {
        error: this.formatError(error),
      });
    }
  }

  stop(): void {
    this.shouldStop = true;
    this.logger.info("Stopping TMDB loader");
  }

  private formatError(error: unknown): { message: string; stack?: string } {
    return {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  private async discoverMovies(): Promise<void> {
    this.logger.info("Starting movie discovery");
    let page = 1;
    let totalMoviesProcessed = 0;
    let totalPages = Infinity;
    while (!this.shouldStop && page < totalPages) {
      page++;
      await this.delay(0);
      const startTime = Date.now();

      const response = await this.tmdbClient.discoverMovies({ page });

      page = response?.page ?? 0;
      totalPages = response?.total_pages ?? 0;

      const movies =
        response?.results?.map((m) =>
          mapKeys(m, (key) => tmdbPrefixKey("movie", key))
        ) ?? [];

      const movieDatoms = datoms(
        {
          e: (m) =>
            tmdbPrefixKey("movie", m["tmdb.movie/id"]?.toString() ?? ""),
        },
        movies
      ).flatMap((datom): DatomInput[] => {
        if (datom.a !== "tmdb.movie/genre_ids") return [datom];

        const genreIds: unknown =
          typeof datom.v === "string" ? JSON.parse(datom.v) : datom.v;
        if (!Array.isArray(genreIds)) return [];

        return genreIds.map(
          (genreId): DatomInput => ({
            a: "tmdb.movie/genre_id",
            v: value(genreId),
            op: "assert",
            e: datom.e,
          })
        );
      });
      await this.db.transact(movieDatoms, { createdBy: "tmdb-loader" });
      totalMoviesProcessed += movies.length;
      this.logger.info("Page processed", {
        page,
        movies: movies.length,
        total: totalMoviesProcessed,
        durationMs: Date.now() - startTime,
      });
    }
    this.logger.info(
      this.shouldStop ? "Movie discovery stopped" : "Movie discovery completed",
      {
        pages: page - 1,
        totalMovies: totalMoviesProcessed,
      }
    );
    this.logger.info("TMDB loader completed successfully");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
