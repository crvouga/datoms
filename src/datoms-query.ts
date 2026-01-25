import type {Attribute, TransactionId, Value} from './datoms.js';
import type {EntityId} from './entity-id.js';
import {QuerySafetyError} from './datom-database/hook/hook.js';
import type {ViewConfig} from './datom-database/views/view-config.js';

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

/**
 * Validate that query has at least one filter or limit to prevent accidental full scans
 */
export function validateDatomsQuery(options: DatomsQuery): void {
  const hasFilter =
    options.e !== undefined ||
    options.a !== undefined ||
    options.v !== undefined ||
    options.tx !== undefined ||
    options.txMax !== undefined;
  const hasLimit = options.limit !== undefined;

  if (!hasFilter && !hasLimit) {
    throw new QuerySafetyError(
      'Query must include at least one filter (entity, attribute, value, tx, txMax) or a limit to prevent full table scans',
    );
  }
}
