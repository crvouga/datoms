import {serve} from 'bun';
import {
  DestroyRetentionPolicy,
  FetchHttpClient,
  HttpClientDatomDatabaseServerComponent,
  PgSQLDatabase,
  PostgreSQLDatomDatabase,
  type Logger,
} from 'datoms';
import index from './index.html';
import {createLogger} from './lib/logger';
import {notepad} from './notepad';
import {DATOMS_API_ENDPOINT} from './shared/api';
import {createTmdbClient} from './tmdb/tmdb-client';
import {TmdbLoader} from './tmdb/tmdb-loader';

async function main() {
  const logger = createLogger();
  const port = Number.parseInt(process.env.PORT || '3847', 10);

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const sqlDb = new PgSQLDatabase(databaseUrl);
  const db = new PostgreSQLDatomDatabase({
    sqlDb: sqlDb,
    tableName: 'datoms',
  });

  await db.initialize();

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

  const server = serve({
    port,
    routes: {
      '/*': index,
      '/notepad': {
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
    development: process.env.NODE_ENV !== 'production' && {
      hmr: true,
      console: true,
    },
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await safeStop(logger, 'retention policy', () => retentionPolicy.stop());
    await safeStop(logger, 'TMDB loader', () => tmdbLoader.stop());
    await safeStop(logger, 'database', () => sqlDb.close());
    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(`🚀 Server running at ${server.url}`);
}

function getErrorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeStop(
  logger: Logger,
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(`Error stopping ${name}`, {error: getErrorMsg(err)});
    throw err;
  }
}

main().catch(err => {
  createLogger().error('Uncaught error', {error: getErrorMsg(err)});
  process.exit(1);
});
