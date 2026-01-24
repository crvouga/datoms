import {serve} from 'bun';
import {FetchHttpClient} from '../../../../http-client/http-client.js';
import {HttpClientDatomDatabaseServerComponent} from '../../../http-client/http-client-datom-database-server-component.js';
import {HttpClientDatomDatabase} from '../../../http-client/http-client-datom-database.js';
import type {Fixture} from '../fixture.js';
import {createPostgresFixture} from './postgres.js';

export const createHttpClientFixture = async (): Promise<Fixture> => {
  const f = await createPostgresFixture();
  const serverDb = f.db;
  const transportServerComponent = new HttpClientDatomDatabaseServerComponent(serverDb);
  const endpoint = '/api/datom-database';
  const server = serve({
    port: 0, // Let OS assign an available port
    routes: {
      [endpoint]: request => transportServerComponent.handleRequest(request),
    },
  });
  // Extract the actual port from the server URL
  const port = Number.parseInt(server.url.port, 10);
  const httpClient = new FetchHttpClient(`http://localhost:${port}`);
  const db = new HttpClientDatomDatabase(httpClient, endpoint);
  await db.initialize();
  return {
    db,
    beforeEach: async () => {
      await f.beforeEach();
    },
    afterEach: async () => {
      await server.stop();
      await f.afterEach();
    },
  };
};
