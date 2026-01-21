/**
 * Internal database view interface for implementation details
 * Used internally by database views and implementations
 * Not part of the public API
 */

import type {DatalogQuery, DatalogQueryFindVariable} from '../../datalog/datalog.js';
import type {DatomDatabase} from '../datom-database.js';
import {validateQueryOptions} from '../shared/query-validation.js';
import type {DatabaseView, DatomsQuery, QueryResultEnvelope} from './database-view.js';
import type {ViewConfig} from './view-config.js';

/**
 * Database view that is configured with a view config
 * Used to create database views with specific configurations
 * @internal
 */
export class ConfiguredDatabaseView implements DatabaseView {
  constructor(
    private db: DatomDatabase,
    private viewConfig: ViewConfig,
  ) {}

  async query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(
    query: DatalogQuery<keyof TFind & string> & {find: TFind},
  ): Promise<QueryResultEnvelope<TFind>> {
    return this.db.query({...query, viewConfig: this.viewConfig});
  }
}
