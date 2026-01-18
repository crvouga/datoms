import { serve } from "bun";
import { PostgreSQLDatomDatabase } from "../../src";
import { PgSQLDatabase } from "../../src/sql-database/sql-database-pg";
import { FetchHttpClient } from "./http-client";
import index from "./index.html";
import { createLogger } from "./lib/logger";
import { createTmdbClient } from "./tmdb/tmdb-client";
import { TmdbLoader } from "./tmdb/tmdb-loader";
import { DestroyRetentionPolicy } from "../../src/datom-database/retention-policy";

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  const logger = createLogger();

  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.error("DATABASE_URL is not set");
      throw new Error("DATABASE_URL is not set");
    }
    logger.info("Connecting to database...", {
      event: "db_connecting",
      databaseUrl,
    });
    const sqlDb = new PgSQLDatabase(databaseUrl);
    const db = new PostgreSQLDatomDatabase(sqlDb);
    const destroyRetentionPolicy = new DestroyRetentionPolicy(db, {
      retentionTxCount: 10,
      intervalMs: 1000,
      batchSize: 1_000,
    });
    destroyRetentionPolicy.start();
    const httpClient = new FetchHttpClient();
    logger.info("Creating TMDB client...", { event: "tmdb_client_creating" });
    const tmdbClient = createTmdbClient(httpClient);
    if (!tmdbClient) {
      logger.error("TMDB_API_READ_ACCESS_TOKEN is not set");
      throw new Error("TMDB_API_READ_ACCESS_TOKEN is not set");
    }
    const tmdbLoader = new TmdbLoader(tmdbClient, db, logger);

    logger.info("Starting TMDB loader...", { event: "tmdb_loader_start" });
    tmdbLoader.start();

    logger.info("Starting server...", { event: "server_starting", port });
    const server = serve({
      port,
      routes: {
        // Serve index.html for all unmatched routes.
        "/*": index,

        "/popular-movies": {
          async GET(_req) {
            logger.info("Querying for movies datoms...", {
              event: "populating_movies_query",
            });
            const populateMovies = await db.query({
              find: {
                "movie/id": ["?e"],
                "movie/title": ["?title"],
                "movie/overview": ["?overview"],
                "movie/releaseDate": ["?release_date"],
                "movie/posterPath": ["?poster_path"],
                "movie/backdropPath": ["?backdrop_path"],
                "movie/voteAverage": ["?vote_average"],
                "movie/voteCount": ["?vote_count"],
              },
              where: [
                { e: "?e", a: "tmdb.movie/id", v: "?id" },
                { e: "?e", a: "tmdb.movie/title", v: "?title" },
                { e: "?e", a: "tmdb.movie/overview", v: "?overview" },
                { e: "?e", a: "tmdb.movie/release_date", v: "?release_date" },
                { e: "?e", a: "tmdb.movie/poster_path", v: "?poster_path" },
                { e: "?e", a: "tmdb.movie/backdrop_path", v: "?backdrop_path" },
                { e: "?e", a: "tmdb.movie/vote_average", v: "?vote_average" },
                { e: "?e", a: "tmdb.movie/vote_count", v: "?vote_count" },
              ],
            });
            logger.info("Movies datoms populated", {
              event: "populated_movies",
              count: populateMovies?.length,
            });
            logger.debug("Movies datoms data", {
              event: "populated_movies_data",
              data: populateMovies,
            });
            return Response.json(populateMovies);
          },
        },

        "/api/hello": {
          async GET(_req) {
            logger.info("Route hit", {
              event: "route_hit",
              route: "/api/hello",
              method: "GET",
            });
            return Response.json({
              message: "Hello, world!",
              method: "GET",
            });
          },
          async PUT(_req) {
            logger.info("Route hit", {
              event: "route_hit",
              route: "/api/hello",
              method: "PUT",
            });
            return Response.json({
              message: "Hello, world!",
              method: "PUT",
            });
          },
        },

        "/api/hello/:name": async (req) => {
          logger.info("Route hit", {
            event: "route_hit",
            route: "/api/hello/:name",
            params: req.params,
          });
          const name = req.params.name;
          return Response.json({
            message: `Hello, ${name}!`,
          });
        },
      },

      development: process.env.NODE_ENV !== "production" && {
        // Enable browser hot reloading in development
        hmr: true,

        // Echo console logs from the browser to the server
        console: true,
      },
    });

    logger.info(`🚀 Server running at ${server.url}`, {
      event: "server_running",
      url: server.url.toString(),
    });
  } catch (err: unknown) {
    if (logger && typeof logger.error === "function") {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Startup error", {
        event: "startup_error",
        error: errorMessage,
      });
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  // global catch fallback
  const logger = createLogger();
  const errorMessage = err instanceof Error ? err.message : String(err);
  logger.error("Uncaught error", {
    event: "uncaught_error",
    error: errorMessage,
  });
});
