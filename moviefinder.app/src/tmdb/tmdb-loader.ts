import type { DatomDatabase } from "../../../src";
import { datoms } from "../../../src/datoms";
import { mapKeys } from "../lib/map-keys";
import { tmdbPrefixKey } from "./tmdb";
import type { TmdbClient } from "./tmdb-client";

export class TmdbLoader {
  constructor(
    private readonly tmdbClient: TmdbClient,
    private readonly db: DatomDatabase
  ) {}

  async start(): Promise<void> {
    await Promise.all([this.discoverMovies()]);
  }

  private async discoverMovies(): Promise<void> {
    let hasMore = true;
    while (hasMore) {
      const response = await this.tmdbClient.discoverMovies({ page: 1 });
      hasMore = (response?.page ?? 0) < (response?.total_pages ?? 0);
      const movies = response?.results?.map((m) =>
        mapKeys(m, (key) => tmdbPrefixKey("movie", key))
      );
      const movieDatoms = datoms(
        {
          e: (m) =>
            tmdbPrefixKey("movie", m["tmdb.movie/id"]?.toString() ?? ""),
        },
        movies
      );
      await this.db.transact(movieDatoms, {
        createdBy: "tmdb-loader",
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
