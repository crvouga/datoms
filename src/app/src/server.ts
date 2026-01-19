import { serve } from "bun";
import { HttpClientDatomDatabaseServerComponent } from "../../datom-database/http-client/http-client-datom-database-server-component";
import { PostgreSQLDatomDatabase } from "../../datom-database/index";
import { DestroyRetentionPolicy } from "../../datom-database/retention-policy";
import { PgSQLDatabase } from "../../sql-database/sql-database-pg";
import type { Logger } from "../../types";
import index from "./index.html";
import { FetchHttpClient } from "./lib/http-client";
import { createLogger } from "./lib/logger";
import { notepad } from "./notepad";
import { DATOMS_API_ENDPOINT } from "./shared/api";
import { createTmdbClient } from "./tmdb/tmdb-client";
import { TmdbLoader } from "./tmdb/tmdb-loader";

async function main() {
  const logger = createLogger();
  const port = parseInt(process.env.PORT || "3000", 10);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");

  const sqlDb = new PgSQLDatabase(databaseUrl);
  const db = new PostgreSQLDatomDatabase({
    sqlDb: sqlDb,
    tableName: "datoms",
    maintenanceConfig: {
      enabled: true,
      intervalMs: 60_000,
      runImmediately: true,
    },
    logger,
  });

  await db.initialize();
  db.startMaintenance();

  const retentionPolicy = new DestroyRetentionPolicy({
    sourceDb: db,
    config: {
      retentionCount: 2,
      intervalMs: 3_000,
    },
    logger,
  });
  retentionPolicy.start();

  const httpClient = new FetchHttpClient();
  const tmdbClient = createTmdbClient(httpClient);
  const tmdbLoader = new TmdbLoader(tmdbClient, db, logger);
  const dbServerComponent = new HttpClientDatomDatabaseServerComponent(db);

  tmdbLoader.start();

  const allDatoms = await db.datoms({ limit: 1_000_000 });

  try {
    allDatoms.sort((a, b) => (a["e"] > b["e"] ? 1 : -1));

    // CSV header
    const header = "e,a,v,tx,op";
    // Convert datoms to CSV rows, escaping quotes and commas properly where necessary
    const rows = allDatoms.map((datom) => {
      // Stringify and escape CSV fields
      function csvEscape(val: unknown): string {
        if (val === null || val === undefined) return "";
        let str = String(val);
        // Escape double quotes by doubling them
        if (/["\n,]/.test(str)) {
          str = '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }
      return [
        csvEscape(datom.e),
        csvEscape(datom.a),
        csvEscape(datom.v),
        csvEscape(datom.tx),
        csvEscape(datom.op),
      ].join(",");
    });

    const csvContent = [header, ...rows].join("\n") + "\n";
    await Bun.write("datoms.csv", csvContent);

    logger.info("allDatoms written to datoms.csv");
  } catch (err) {
    logger.error("Failed to write allDatoms", { error: getErrorMsg(err) });
  }

  const server = serve({
    port,
    routes: {
      "/*": index,
      "/notepad": {
        async GET() {
          return Response.json(await notepad(db));
        },
      },
      [DATOMS_API_ENDPOINT]: {
        async POST(req) {
          return dbServerComponent.handleRequest(req);
        },
      },
    },
    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await safeStop(logger, "retention policy", () => retentionPolicy.stop());
    await safeStop(logger, "TMDB loader", () => tmdbLoader.stop());
    await safeStop(logger, "database", () => sqlDb.close());
    logger.info("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info(`🚀 Server running at ${server.url}`);
}

function getErrorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeStop(
  logger: Logger,
  name: string,
  fn: () => void | Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(`Error stopping ${name}`, { error: getErrorMsg(err) });
    throw err;
  }
}

main().catch((err) => {
  createLogger().error("Uncaught error", { error: getErrorMsg(err) });
  process.exit(1);
});
