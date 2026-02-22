import {serve} from 'bun';
import {
  DestroyRetentionPolicy,
  FetchHttpClient,
  HttpClientDatomDatabaseServerComponent,
  PostgreSQLDatomDatabase,
  type Logger,
} from 'datoms';
import {PgSQLDatabase} from 'datoms/adapters/pg';
import path from 'node:path';
import {createLogger} from './lib/logger';
import {notepad} from './notepad';
import {DATOMS_API_ENDPOINT} from './shared/api';
import {createTmdbClient} from './tmdb/tmdb-client';
import {TmdbLoader} from './tmdb/tmdb-loader';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getContentType(pathname: string): string {
  const ext = path.extname(pathname);
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

async function serveStaticOrSpa(req: Request, distDir: string): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const requestedPath = pathname.replace(/^\//, '');
  const safePath = path.resolve(distDir, requestedPath);
  const distResolved = path.resolve(distDir);
  if (!safePath.startsWith(distResolved + path.sep) && safePath !== distResolved) {
    return new Response('Forbidden', {status: 403});
  }
  const file = Bun.file(safePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: {'Content-Type': getContentType(pathname)},
    });
  }
  const indexFile = Bun.file(path.join(distDir, 'index.html'));
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {'Content-Type': 'text/html'},
    });
  }
  return new Response('Client not built. Run `bun run build:client` first.', {
    status: 404,
    headers: {'Content-Type': 'text/plain'},
  });
}

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

  const distDir = path.join(import.meta.dir, '..', 'dist');

  const server = serve({
    port,
    routes: {
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
      '/*': async req => serveStaticOrSpa(req, distDir),
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
