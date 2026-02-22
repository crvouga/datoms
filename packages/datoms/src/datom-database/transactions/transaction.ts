import type {Datom} from '../../datoms';
import type {DatomDatabase} from '../datom-database';

export const TX_META_TX = 'tx-meta/tx';
export const TX_META_ORDER = 'tx-meta/order';
export const TX_META_WEIGHT = 'tx-meta/weight';
export const TX_META_TIMESTAMP = 'tx-meta/timestamp';

export const test = (_db: DatomDatabase) => {
  const tx = 123;
  const txMetaId = Math.random().toString(36).slice(2);
  const datoms: Datom[] = [
    {op: true, e: 'person-1', a: 'person/name', v: 'Alice', tx},
    //
    {op: true, e: txMetaId, a: TX_META_TX, v: tx, tx},
    {op: true, e: txMetaId, a: TX_META_ORDER, v: 1, tx},
    {op: true, e: txMetaId, a: TX_META_TIMESTAMP, v: new Date().toISOString(), tx},
    {op: true, e: txMetaId, a: TX_META_WEIGHT, v: 100, tx},
  ];

  return datoms;
};
