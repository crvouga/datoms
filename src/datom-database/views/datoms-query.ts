import type {Attribute, TransactionId, Value} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {ViewConfig} from './view-config.js';
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
