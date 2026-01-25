/**
 * HTTP client database instance for frontend
 */

import type {DatalogQuery} from '../../../datalog';
import {HttpClientDatomDatabase} from '../../../datom-database/http-client/http-client-datom-database';
import type {QueryResult} from '../../../datom-database/views/database-view';
import {DATOMS_API_ENDPOINT} from '../shared/api';
import {FetchHttpClient} from './http-client';

// Re-export types for convenience
export type {DatalogQuery, QueryResult};

const httpClient = new FetchHttpClient();
export const db = new HttpClientDatomDatabase(httpClient, DATOMS_API_ENDPOINT);

// Initialize the database when the module loads
db.initialize().catch((error: unknown) => {
  console.error('Failed to initialize HTTP client database:', error);
});
