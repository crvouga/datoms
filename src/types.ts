/**
 * Core types for the datoms database
 */

/**
 * A unique identifier for an entity
 */
export type EntityId = number | string | symbol;

/**
 * An attribute name (e.g., "name", "age", "email")
 */
export type Attribute = string | symbol;

/**
 * A value that can be stored in a datom
 */
export type Value =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | EntityId;

/**
 * A transaction ID (monotonically increasing)
 */
export type TransactionId = number;

/**
 * A datom represents a fact: (entity, attribute, value, transaction)
 * This is the fundamental unit of data in a datalog database
 */
export interface Datom {
  /** The entity this datom describes */
  entity: EntityId;
  /** The attribute being asserted */
  attribute: Attribute;
  /** The value of the attribute */
  value: Value;
  /** The transaction ID when this datom was added */
  tx: TransactionId;
  /** Whether this datom is an addition (true) or retraction (false) */
  added: boolean;
}

/**
 * A partial datom for adding/retracting facts (without tx and added)
 * Tuple format: [entity, attribute, value]
 * This is more efficient and aligns with the fixed EAV structure
 */
export type DatomInput = [EntityId, Attribute, Value];

/**
 * Constants for tuple indices (for better readability when needed)
 */
export const DATOM_ENTITY = 0;
export const DATOM_ATTRIBUTE = 1;
export const DATOM_VALUE = 2;

/**
 * Options for querying datoms
 */
export interface QueryOptions {
  /** Filter by entity ID */
  entity?: EntityId;
  /** Filter by attribute */
  attribute?: Attribute;
  /** Filter by value */
  value?: Value;
  /** Filter by transaction ID */
  tx?: TransactionId;
  /** Only return added datoms (default: true) */
  added?: boolean;
  /** Limit the number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Query database state as it existed at this transaction ID (time-travel query) */
  asOf?: TransactionId;
  /** Query full history of changes (all datoms matching filters, not just latest) */
  history?: boolean;
}

/**
 * Definition for an attribute schema
 */
export interface AttributeDefinition {
  /** Attribute name */
  name: string;
  /** Whether the attribute can have one or many values */
  cardinality: "one" | "many";
  /** Whether the attribute value must be unique across all entities */
  unique?: boolean;
  /** Whether to create an index for this attribute */
  indexed?: boolean;
}

/**
 * Schema for the database
 */
export interface Schema {
  /** Map of attribute names to their definitions */
  attributes: Map<string, AttributeDefinition>;
}
