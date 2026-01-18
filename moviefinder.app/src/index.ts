import { serve } from "bun";
import { PostgreSQLDatomDatabase } from "../../src";
import { PgSQLDatabase } from "../../src/sql-database/sql-database-pg";
import { FetchHttpClient } from "./http-client";
import index from "./index.html";
import { createTmdbClient } from "./tmdb/tmdb-client";
import { TmdbLoader } from "./tmdb/tmdb-loader";

async function main() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const sqlDb = new PgSQLDatabase(databaseUrl);
  const db = new PostgreSQLDatomDatabase(sqlDb);
  const httpClient = new FetchHttpClient();
  const tmdbClient = createTmdbClient(httpClient);
  if (!tmdbClient) throw new Error("TMDB_API_READ_ACCESS_TOKEN is not set");
  const tmdbLoader = new TmdbLoader(tmdbClient, db);

  tmdbLoader.start();

  const server = serve({
    port,
    routes: {
      // Serve index.html for all unmatched routes.
      "/*": index,

      "/datoms": {
        async GET(_req) {
          const datoms = await db.datoms({ limit: 1000 });
          return Response.json(datoms);
        },
      },

      "/api/hello": {
        async GET(_req) {
          return Response.json({
            message: "Hello, world!",
            method: "GET",
          });
        },
        async PUT(_req) {
          return Response.json({
            message: "Hello, world!",
            method: "PUT",
          });
        },
      },

      "/api/hello/:name": async (req) => {
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

  console.log(`🚀 Server running at ${server.url}`);
}

main().catch(console.error);
