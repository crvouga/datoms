/**
 * Abstract datom database class for working with datoms
 * Provides a high-level interface for working with datoms and datalog queries
 */

import type { Datom, TransactionId } from "../../datoms.js";

/**
 * Configuration for database views
 * Views use this to pass their configuration to implementations
 * @internal
 */
export type ViewConfig =
  | { type: "current" }
  | { type: "asOf"; txId: TransactionId }
  | { type: "since"; txId: TransactionId }
  | { type: "history" }
  | { type: "speculative"; datoms: Datom[] };
