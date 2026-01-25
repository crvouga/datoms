/**
 * Internal datom database view interface for implementation details
 * Used internally by database views and implementations
 * Not part of the public API
 */

import type {DatalogQuery, DatalogQueryFindVariable} from '../datalog-query.js';
import type {DatomDatabase} from './datom-database.js';
import type {DatomDatabaseView, QueryResultEnvelope} from './datom-database-view.js';
import type {DatomDatabaseViewConfig} from './datom-database-view-config.js';

/**
 * Datom database view that is configured with a view config
 * Used to create datom database views with specific configurations
 * @internal
 */
export class ConfiguredDatomDatabaseView implements DatomDatabaseView {
  constructor(
    private db: DatomDatabase,
    private viewConfig: DatomDatabaseViewConfig,
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
