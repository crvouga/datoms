import type { DatomDatabase, Logger } from "../../../src";
import { datoms } from "../../../src/datoms";
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
    this.logger.info("Starting TMDB loader", { operation: "start" });
    try {
      await Promise.all([this.discoverMovies()]);
      this.logger.info("TMDB loader completed successfully", {
        operation: "complete",
      });
    } catch (error) {
      this.logger.error("TMDB loader failed", {
        operation: "start",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  stop(): void {
    this.shouldStop = true;
    this.logger.info("Stopping TMDB loader", { operation: "stop" });
  }

  private async discoverMovies(): Promise<void> {
    this.logger.info("Starting movie discovery", {
      operation: "discoverMovies",
    });
    let hasMore = true;
    let runningPage = 1;
    let totalMoviesProcessed = 0;

    while (hasMore && !this.shouldStop) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const pageStartTime = Date.now();
      this.logger.debug("Fetching movies page", {
        operation: "discoverMovies",
        page: runningPage,
      });
      let response;
      try {
        response = await this.tmdbClient.discoverMovies({ page: runningPage });
      } catch (error) {
        this.logger.error("Failed to fetch movies from TMDB API", {
          operation: "discoverMovies",
          page: runningPage,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }

      if (!response) {
        this.logger.warn("Received null response from TMDB API", {
          operation: "discoverMovies",
          page: runningPage,
        });
        break;
      }

      runningPage = response.page ?? 0;
      const totalPages = response.total_pages ?? 0;
      hasMore = runningPage < totalPages;

      this.logger.debug("Received TMDB API response", {
        operation: "discoverMovies",
        page: runningPage,
        totalPages,
        resultsCount: response.results?.length ?? 0,
        hasMore,
      });

      if (!response.results || response.results.length === 0) {
        this.logger.warn("No movies in response", {
          operation: "discoverMovies",
          page: runningPage,
        });
        runningPage++;
        continue;
      }

      const movies = response.results.map((m) =>
        mapKeys(m, (key) => tmdbPrefixKey("movie", key))
      );
      this.logger.debug("Mapped movie keys", {
        operation: "discoverMovies",
        page: runningPage,
        movieCount: movies.length,
      });

      const movieDatoms = datoms(
        {
          e: (m) =>
            tmdbPrefixKey("movie", m["tmdb.movie/id"]?.toString() ?? ""),
        },
        movies
      );

      const transactionStartTime = Date.now();
      try {
        await this.db.transact(movieDatoms, {
          createdBy: "tmdb-loader",
        });
        const transactionDuration = Date.now() - transactionStartTime;
        totalMoviesProcessed += movies.length;

        this.logger.info("Transaction committed successfully", {
          operation: "discoverMovies",
          page: runningPage,
          movieCount: movies.length,
          totalMoviesProcessed,
          transactionDurationMs: transactionDuration,
        });
      } catch (error) {
        const transactionDuration = Date.now() - transactionStartTime;
        this.logger.error("Transaction failed", {
          operation: "discoverMovies",
          page: runningPage,
          movieCount: movies.length,
          transactionDurationMs: transactionDuration,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }

      const pageDuration = Date.now() - pageStartTime;
      this.logger.debug("Page processing completed", {
        operation: "discoverMovies",
        page: runningPage,
        pageDurationMs: pageDuration,
      });

      if (hasMore) {
        this.logger.debug("Rate limiting delay", {
          operation: "discoverMovies",
          delayMs: 5000,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      runningPage++;
    }

    if (this.shouldStop) {
      this.logger.info("Movie discovery stopped by user", {
        operation: "discoverMovies",
        totalPagesProcessed: runningPage - 1,
        totalMoviesProcessed,
      });
    } else {
      this.logger.info("Movie discovery completed", {
        operation: "discoverMovies",
        totalPagesProcessed: runningPage - 1,
        totalMoviesProcessed,
      });
    }
  }
}
