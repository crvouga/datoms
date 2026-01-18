import { serve } from "bun";
import { PostgreSQLDatomDatabase, type DatalogQuery } from "../../src";
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
      batchSize: 10_000,
    });
    destroyRetentionPolicy.start();

    // PostgreSQL maintenance: VACUUM ANALYZE on interval
    const maintenanceIntervalMs = 1000 * 10;
    const tableName = process.env.POSTGRES_TABLE_NAME || "datoms"; // Default: "datoms"
    // Validate table name to prevent SQL injection (alphanumeric and underscores only)
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new Error(
        `Invalid table name: ${tableName}. Only alphanumeric characters and underscores are allowed.`
      );
    }
    const runPostgresMaintenance = async () => {
      try {
        logger.info("Running PostgreSQL maintenance...", {
          event: "postgres_maintenance_start",
          tableName,
        });
        // VACUUM ANALYZE on both tables to reclaim storage and update statistics
        // VACUUM ANALYZE reclaims storage occupied by dead tuples and updates statistics
        await sqlDb.execute(`VACUUM ANALYZE ${tableName}`);
        await sqlDb.execute(`VACUUM ANALYZE ${tableName}_tx`);
        logger.info("PostgreSQL maintenance completed", {
          event: "postgres_maintenance_complete",
          tableName,
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("PostgreSQL maintenance error", {
          event: "postgres_maintenance_error",
          error: errorMessage,
          tableName,
        });
      }
    };
    // Run maintenance immediately, then on interval
    runPostgresMaintenance();
    const maintenanceInterval = setInterval(
      runPostgresMaintenance,
      maintenanceIntervalMs
    );

    const httpClient = new FetchHttpClient();
    logger.info("Creating TMDB client...", { event: "tmdb_client_creating" });
    const tmdbClient = createTmdbClient(httpClient);
    if (!tmdbClient) {
      logger.error("TMDB_API_READ_ACCESS_TOKEN is not set");
      throw new Error("TMDB_API_READ_ACCESS_TOKEN is not set");
    }
    const tmdbLoader = new TmdbLoader(tmdbClient, db, logger);

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

      // Clear maintenance interval
      clearInterval(maintenanceInterval);

      // Close database connections
      try {
        await sqlDb.close();
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
              ],
              orderBy: [["?popularity", "desc"]],
              limit: 25,
            };
            const populateMovies = await db.query(q);
            logger.info("Movies datoms populated", {
              event: "populated_movies",
              count: populateMovies?.length,
            });
            logger.debug("Movies datoms data", {
              event: "populated_movies_data",
              data: populateMovies,
            });
            return Response.json([q, ...populateMovies]);
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
