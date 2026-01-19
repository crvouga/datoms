import { serve } from "bun";
import type { Fixture } from "../fixture.js";
import { FetchHttpClient } from "../../../../http-client/http-client.js";
import { HttpClientDatomDatabaseServerComponent } from "../../../http-client/http-client-datom-database-server-component.js";
import { HttpClientDatomDatabase } from "../../../http-client/http-client-datom-database.js";
import { InMemoryDatomDatabase } from "../../../in-memory/in-memory-datom-database.js";

export const createHttpClientFixture = async (): Promise<Fixture> => {
  const serverDb = new InMemoryDatomDatabase();
  const transportServerComponent = new HttpClientDatomDatabaseServerComponent(
    serverDb
  );
  const endpoint = `/api/datom-database`;
  const server = serve({
    port: 0, // Let OS assign an available port
    routes: {
      [endpoint]: (request) => transportServerComponent.handleRequest(request),
    },
  });
  // Extract the actual port from the server URL
  const port = parseInt(server.url.port, 10);
  const httpClient = new FetchHttpClient(`http://localhost:${port}`);
  const db = new HttpClientDatomDatabase(httpClient, endpoint);
  await db.initialize();
  return {
    db,
    beforeEach: async () => {
      // Reset the server database state between tests
      await serverDb.close();
      await serverDb.initialize();
      // Also reset the remote database's initialization state
      await db.initialize();
    },
    afterEach: async () => {
      await server.stop();
    },
  };
};
