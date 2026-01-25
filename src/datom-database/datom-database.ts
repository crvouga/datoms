import type {Datom, DatomInput, TransactionId} from '../datoms.js';
import type {EntityId} from '../entity-id.js';
import type {Transaction} from '../types.js';
import type {Hook} from './hook/hook.js';
import type {DatomDatabaseView} from './datom-database-view.js';

/**
 * Minimal Datom database API for querying, transacting, and speculative views.
 */
export interface DatomDatabase extends DatomDatabaseView {
  /** Initialize the database. */
  initialize(): Promise<void>;
  /** Register a database-level hook. */
  hook(hook: Hook): void;
  /** Atomically apply a batch of datom operations. */
  transact(
    ops: (DatomInput | DatomInput[] | Datom | Datom[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Promise<TransactionId>;
  /** Read-only view at a transaction id. */
  asOf(txId: TransactionId): DatomDatabaseView;
  /** Read-only view of the full history. */
  history(): DatomDatabaseView;
  /** Read-only view of changes since a transaction id. */
  since(txId: TransactionId): DatomDatabaseView;
  /** Preview the effect of a transaction without committing it. */
  with(ops: DatomInput[]): Promise<WithResult>;
  /** Get the latest transaction data. */
  _getLatestTransaction(): Promise<Transaction>;
  _destroy(config: {retentionCount: number}): Promise<number>;
}

/** Result of a speculative transaction with .with() */
export interface WithResult {
  dbBefore: DatomDatabaseView;
  dbAfter: DatomDatabaseView;
  txData: Datom[];
  tempIds: Record<string, EntityId>;
}
