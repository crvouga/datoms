import type {DatalogQuery, DatalogQueryFindVariable} from '../datalog-query.js';
import type {Attribute, Value} from '../datoms.js';
import type {EntityId} from '../entity-id.js';

// Maps find clause keys to possible result types
export type QueryResultFromFind<TFind extends Record<string, DatalogQueryFindVariable>> = Array<{
  [K in keyof TFind]: Value | Attribute | EntityId;
}>;

// Array of results, shaped by find clause
export type QueryResult<
  TFind extends Record<string, DatalogQueryFindVariable> = Record<string, DatalogQueryFindVariable>,
> = QueryResultFromFind<TFind>;

// Query result data plus optional metadata
export type QueryResultEnvelope<
  TFind extends Record<string, DatalogQueryFindVariable> = Record<string, DatalogQueryFindVariable>,
> = {
  data: QueryResult<TFind>;
  metadata?: Record<string, unknown>;
};

// Database view interface for querying (read-only)
export interface DatomDatabaseView {
  query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(query: DatalogQuery<keyof TFind & string> & {find: TFind}): Promise<QueryResultEnvelope<TFind>>;
}
