import type {Datom, DatomInput, TransactionId} from '../datoms.js';
import type {EntityId} from '../entity-id.js';
import type {Transaction} from '../types.js';
import type {Hook} from './hook/hook.js';
import type {DatabaseView} from './views/database-view.js';

/**
 * Minimal Datom database API for querying, transacting, and speculative views.
 */
export interface DatomDatabase extends DatabaseView {
  /** Initialize the database. */
  initialize(): Promise<void>;
  /** Close all connections and resources. */
  close(): Promise<void>;
  /** Register a database-level hook. */
  hook(hook: Hook): void;
  /** Atomically apply a batch of datom operations. */
  transact(
    ops: (DatomInput | DatomInput[] | Datom | Datom[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Promise<TransactionId>;
  /** Read-only view at a transaction id. */
  asOf(txId: TransactionId): DatabaseView;
  /** Read-only view of the full history. */
  history(): DatabaseView;
  /** Read-only view of changes since a transaction id. */
  since(txId: TransactionId): DatabaseView;
  /** Preview the effect of a transaction without committing it. */
  with(ops: DatomInput[]): Promise<WithResult>;
  /** Get the latest transaction data. */
  _getLatestTransaction(): Promise<Transaction>;
  _destroy(config: {retentionCount: number}): Promise<number>;
}

/** Result of a speculative transaction with .with() */
export interface WithResult {
  dbBefore: DatabaseView;
  dbAfter: DatabaseView;
  txData: Datom[];
  tempIds: Record<string, EntityId>;
}
