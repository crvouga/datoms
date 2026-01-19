import { serve } from "bun";
import {
  PostgreSQLDatomDatabase,
  SQLiteDatomDatabase,
  datalogToPostgresSQL,
  type DatalogQuery,
} from "../../datom-database/index";
import { DestroyRetentionPolicy } from "../../datom-database/retention-policy";
import { HttpClientDatomDatabaseServerComponent } from "../../datom-database/http-client/http-client-datom-database-server-component";
import { PgSQLDatabase } from "../../sql-database/sql-database-pg";
import { SQLiteSQLDatabase } from "../../sql-database/sql-database-sqlite";
import { FetchHttpClient } from "./lib/http-client";
import index from "./index.html";
import { createLogger } from "./lib/logger";
import { createTmdbClient } from "./tmdb/tmdb-client";
import { TmdbLoader } from "./tmdb/tmdb-loader";
import { DATOMS_API_ENDPOINT } from "./shared/api";
import type { Logger } from "../../types";

async function main() {
  const logger = createLogger();

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  logger.info("Starting server...", { event: "server_starting", port });

  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || databaseUrl.trim() === "") {
      logger.error("DATABASE_URL is not set");
      throw new Error("DATABASE_URL is not set");
    }
    logger.info("Connecting to database...", {
      event: "db_connecting",
      databaseUrl,
    });
    const sqliteSqlDb = new SQLiteSQLDatabase(":memory:");
    const sqliteDb = new SQLiteDatomDatabase(sqliteSqlDb);
    const postgresSqlDb = new PgSQLDatabase(databaseUrl);
    const tableName = process.env.POSTGRES_TABLE_NAME || "datoms"; // Default: "datoms"
    const postgresDb = new PostgreSQLDatomDatabase(
      postgresSqlDb,
      tableName,
      {
        enabled: true,
        intervalMs: 1000 * 60, // 1 minute
        runImmediately: true,
      },
      logger
    );
    // eslint-disable-next-line no-constant-condition
    const db = false ? sqliteDb : postgresDb;

    // Initialize database and start maintenance if using PostgreSQL
    await db.initialize();
    if (db === postgresDb) {
      postgresDb.startMaintenance();
    }

    const destroyRetentionPolicy = new DestroyRetentionPolicy(
      db,
      {
        retentionTxCount: 10,
        intervalMs: 3000,
        batchSize: 5_000,
      },
      logger as Logger
    );
    destroyRetentionPolicy.start();

    const httpClient = new FetchHttpClient();
    logger.info("Creating TMDB client...", { event: "tmdb_client_creating" });
    const tmdbClient = createTmdbClient(httpClient);
    if (!tmdbClient) {
      logger.error("TMDB_API_READ_ACCESS_TOKEN is not set");
      throw new Error("TMDB_API_READ_ACCESS_TOKEN is not set");
    }
    const tmdbLoader = new TmdbLoader(tmdbClient, db, logger);

    // Create HTTP client database server component
    const httpClientServerComponent =
      new HttpClientDatomDatabaseServerComponent(db);

    // Graceful shutdown handler (defined after all resources are created)
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`, {
        event: "shutdown_start",
        signal,
      });

      // Stop retention policy
      try {
        destroyRetentionPolicy.stop();
        logger.info("Retention policy stopped", {
          event: "retention_policy_stopped",
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("Error stopping retention policy", {
          event: "retention_policy_stop_error",
          error: errorMessage,
        });
      }

      // Stop TMDB loader
      try {
        tmdbLoader.stop();
        logger.info("TMDB loader stopped", {
          event: "tmdb_loader_stopped",
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("Error stopping TMDB loader", {
          event: "tmdb_loader_stop_error",
          error: errorMessage,
        });
      }

      // Close database connections
      try {
        await postgresSqlDb.close();
        logger.info("Database connections closed", {
          event: "database_closed",
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("Error closing database", {
          event: "database_close_error",
          error: errorMessage,
        });
      }

      logger.info("Shutdown complete", {
        event: "shutdown_complete",
      });

      // Exit the process
      process.exit(0);
    };

    // Register signal handlers
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

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
            const q: DatalogQuery = {
              find: {
                "movie/id": ["?movie/id"],
                "movie/title": ["?title"],
                "movie/overview": ["?overview"],
                "movie/releaseDate": ["?release_date"],
                "movie/posterPath": ["?poster_path"],
                "movie/backdropPath": ["?backdrop_path"],
                "movie/voteAverage": ["?vote_average"],
                "movie/voteCount": ["?vote_count"],
                "movie/popularity": ["?popularity"],
                "movie/genreId": ["?genre_id"],
              },
              where: [
                { e: "?movie/id", a: "tmdb.movie/id", v: "?id" },
                { e: "?movie/id", a: "tmdb.movie/title", v: "?title" },
                { e: "?movie/id", a: "tmdb.movie/overview", v: "?overview" },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/release_date",
                  v: "?release_date",
                },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/poster_path",
                  v: "?poster_path",
                },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/backdrop_path",
                  v: "?backdrop_path",
                },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/vote_average",
                  v: "?vote_average",
                },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/vote_count",
                  v: "?vote_count",
                },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/popularity",
                  v: "?popularity",
                },
                {
                  e: "?movie/id",
                  a: "tmdb.movie/genre_id",
                  v: "?genre_ids",
                },
              ],
              orderBy: [["?popularity", "desc"]],
              limit: 25,
            };
            const psql = datalogToPostgresSQL(q);
            const compliedPsql = psql.params.reduce<string>((acc, param) => {
              return acc.replace(`?`, String(param));
            }, psql.sql);
            const start = performance.now();
            const populateMovies = await db.query(q);
            logger.info("Movies datoms populated", {
              event: "populated_movies",
              count: populateMovies?.length,
            });
            logger.debug("Movies datoms data", {
              event: "populated_movies_data",
              data: populateMovies,
            });
            const end = performance.now();
            const duration = end - start;

            return Response.json([
              duration,
              q,
              compliedPsql,
              ...populateMovies,
              duration,
            ]);
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

        [DATOMS_API_ENDPOINT]: {
          async POST(req) {
            logger.info("Datoms API request", {
              event: "datoms_api_request",
              route: DATOMS_API_ENDPOINT,
            });
            return httpClientServerComponent.handleRequest(req);
          },
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
