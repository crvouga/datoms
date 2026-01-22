import type {DatalogQuery, DatalogQueryFindVariable} from '../../datalog/datalog.js';
import type {Attribute, Datom, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {ViewConfig} from './view-config.js';

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

// Internal: datom/query filter options
export interface DatomsQuery {
  e?: EntityId;
  a?: Attribute;
  v?: Value;
  tx?: TransactionId;
  txMax?: TransactionId;
  op?: boolean;
  limit?: number;
  offset?: number;
  indexHint?: string | string[];
  timeoutMs?: number;
  maxResultSize?: number;
  context?: Record<string, unknown>;
  viewConfig?: ViewConfig;
}

// Database view interface for querying (read-only)
export interface DatabaseView {
  query<
    TFind extends Record<string, DatalogQueryFindVariable> = Record<
      string,
      DatalogQueryFindVariable
    >,
  >(query: DatalogQuery<keyof TFind & string> & {find: TFind}): Promise<QueryResultEnvelope<TFind>>;
}
