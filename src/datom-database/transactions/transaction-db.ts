import type {DatalogQueryWhereClause} from '../../datalog.js';
import type {Datom, TransactionId} from '../../datoms.js';
import type {Transaction} from '../../types.js';
import type {DatomDatabase} from '../datom-database.js';

/**
 * Helper class to query transaction data using datalog queries.
 * Provides methods to retrieve transaction information without using internal APIs.
 */
export class TransactionDb {
  constructor(private readonly db: DatomDatabase) {}

  /**
   * Get the latest transaction from the database using datalog queries.
   * @returns The latest transaction with its ID, datoms, and metadata
   */
  async getLatestTransaction(): Promise<Transaction> {
    // Step 1: Find the maximum transaction ID
    const maxTxResult = await this.db.query({
      find: {maxTx: {t: 'max', c: '?tx', count: 1}},
      where: [{e: '?e', a: '?a', v: '?v', tx: '?tx'}],
    });

    const maxTxId = maxTxResult.data[0]?.maxTx as TransactionId | undefined;

    // If no transactions exist, return empty transaction
    if (!maxTxId) {
      return {txId: 0, datoms: [], meta: undefined};
    }

    // Step 2: Get all datoms for that transaction ID from history view
    // History view includes both op: true and op: false datoms
    const datomsResult = await this.db.history().query({
      find: {
        e: {t: 'identity', c: '?e'},
        a: {t: 'identity', c: '?a'},
        v: {t: 'identity', c: '?v'},
        tx: {t: 'identity', c: '?tx'},
        op: {t: 'identity', c: '?op'},
      },
      where: [
        {e: '?e', a: '?a', v: '?v', tx: '?tx'},
        ['=', '?tx', maxTxId] as unknown as DatalogQueryWhereClause,
      ],
    });

    // Convert query results to Datom format
    const datoms: Datom[] = datomsResult.data.map(row => ({
      e: row.e as number,
      a: row.a as string,
      v: row.v,
      tx: row.tx as TransactionId,
      op: row.op as boolean,
    }));

    return {
      txId: maxTxId,
      datoms,
      meta: undefined, // Metadata retrieval would require additional implementation
    };
  }
}
