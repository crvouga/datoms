/**
 * Core datom types and utilities
 */

import { EntityId } from "./entity-id";

/**
 * An attribute name (e.g., "name", "age", "email", "user/type", "user/email", "user/name")
 */
export type Attribute = string;

/**
 * A value that can be stored in a datom.
 *
 * **Type Safety:** This is a strict union type of allowed value types.
 * All values must be one of these types - no other types are permitted.
 *
 * **Supported Types:**
 * - Primitives: `string`, `number`, `boolean`
 * - Temporal: `Date` objects
 * - Nullability: `null`, `undefined` (for optional attributes)
 * - References: `EntityId` (number | string) for entity relationships
 *
 * **Note:** `EntityId` is included here to allow referencing other entities as values.
 * Since `EntityId` can be `number | string`, numeric entity IDs overlap with
 * the `number` type, which is intentional and handled correctly by TypeScript.
 *
 * @example
 * // Valid values in datoms:
 * { e: 1, a: "name", v: "Alice", op: "assert" }                    // string
 * { e: 1, a: "age", v: 30, op: "assert" }                          // number
 * { e: 1, a: "active", v: true, op: "assert" }                      // boolean
 * { e: 1, a: "createdAt", v: new Date(), op: "assert" }            // Date
 * { e: 1, a: "middleName", v: null, op: "assert" }                 // null
 * { e: 1, a: "optional", v: undefined, op: "assert" }              // undefined
 * { e: 1, a: "parent", v: 42, op: "assert" }                       // EntityId (number)
 * { e: 1, a: "owner", v: "user-123", op: "assert" }               // EntityId (string)
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

export type DatomOperation = "assert" | "retract";

/**
 * A datom represents a fact: { e: entity, a: attribute, v: value, tx: transaction, op: "assert" | "retract" }
 * This is the fundamental unit of data in a datalog database
 */
export type Datom = {
  /** The entity this datom describes */
  e: EntityId;
  /** The attribute being asserted */
  a: Attribute;
  /** The value of the attribute */
  v: Value;
  /** The transaction ID when this datom was added */
  tx: TransactionId;
  /** The operation type (assert or retract) */
  op: DatomOperation;
};

/**
 * A partial datom for asserting/retracting facts (without tx)
 * Object format: { e: entity, a: attribute, v: value, op: operation }
 * This is more efficient and aligns with the fixed EAV structure
 */
export type DatomInput = {
  /** The entity this datom describes */
  e: EntityId;
  /** The attribute being asserted */
  a: Attribute;
  /** The value of the attribute */
  v: Value;
  /** The operation type (assert or retract) */
  op: DatomOperation;
};

/**
 * Converts records with an `entityId` property into an array of `DatomInput` objects.
 *
 * This utility function simplifies the creation of datoms from object records by automatically
 * converting each property (except `entityId`) into a datom with `op: "assert"`.
 *
 * **Features:**
 * - Accepts variadic arguments (multiple records or arrays of records)
 * - Flattens nested arrays automatically
 * - Converts each property to a datom attribute-value pair
 * - Uses the record's `entityId` as the entity ID for all generated datoms
 * - Sets operation to `"assert"` for all generated datoms
 *
 * **Type Safety:**
 * - Requires records to have an `entityId` property of type `EntityId`
 * - All property values are cast to `Value` type
 * - Returns a flat array of `DatomInput` objects
 *
 * @template T - A type that extends an object with an `entityId` property
 * @param records - One or more records (or arrays of records) to convert to datoms
 * @returns An array of `DatomInput` objects ready for transaction
 *
 * @example
 * // Single record
 * const datoms = datoms({
 *   entityId: 1,
 *   name: "Alice",
 *   age: 30,
 *   active: true
 * });
 * // Returns:
 * // [
 * //   { e: 1, a: "entityId", v: 1, op: "assert" },
 * //   { e: 1, a: "name", v: "Alice", op: "assert" },
 * //   { e: 1, a: "age", v: 30, op: "assert" },
 * //   { e: 1, a: "active", v: true, op: "assert" }
 * // ]
 *
 * @example
 * // Multiple records
 * const datoms = datoms(
 *   { entityId: 1, name: "Alice" },
 *   { entityId: 2, name: "Bob" }
 * );
 * // Returns datoms for both entities
 *
 * @example
 * // Array of records
 * const users = [
 *   { entityId: 1, name: "Alice" },
 *   { entityId: 2, name: "Bob" }
 * ];
 * const datoms = datoms(users);
 * // Returns datoms for all users in the array
 *
 * @example
 * // Mixed records and arrays
 * const datoms = datoms(
 *   { entityId: 1, name: "Alice" },
 *   [{ entityId: 2, name: "Bob" }, { entityId: 3, name: "Charlie" }]
 * );
 * // Returns datoms for all three entities
 *
 * @example
 * // Usage in a transaction
 * await db.transact(
 *   datoms({
 *     entityId: 1,
 *     [USER_TYPE]: USER_TYPE_ADMIN,
 *     [USER_NAME]: "Admin User",
 *     "user/email": "admin@example.com"
 *   })
 * );
 */
export const datoms = <T extends { entityId: EntityId; op?: DatomOperation }>(
  ...records: (T | T[])[]
): DatomInput[] => {
  return records.flatMap((r) =>
    (Array.isArray(r) ? r : [r]).flatMap((r) => {
      const datoms: DatomInput[] = [];
      for (const [key, value] of Object.entries(r)) {
        datoms.push({
          e: r.entityId,
          a: key,
          v: value as Value,
          op: r.op ?? "assert",
        });
      }
      return datoms;
    })
  );
};

/**
 * Converts an array of `DatomInput` objects back into records grouped by entity.
 *
 * This utility function is the inverse of `datoms()` - it reconstructs records from datoms
 * by grouping datoms by their entity ID and converting them into plain objects mapping
 * attributes to values.
 *
 * **Features:**
 * - Accepts variadic arguments (multiple datoms or arrays of datoms)
 * - Flattens nested arrays automatically
 * - Groups datoms by entity ID
 * - Converts each entity's datoms into a record object
 * - Returns one record per unique entity ID
 *
 * **Type Safety:**
 * - Accepts `DatomInput` objects or arrays of `DatomInput` objects
 * - Returns an array of records mapping `Attribute` to `Value`
 * - Each record represents one entity with all its attributes
 *
 * **Note:** This function groups datoms by entity ID. If multiple datoms have the same
 * entity ID but different attributes, they will be merged into a single record. If multiple
 * datoms have the same entity ID and attribute, the last one will overwrite previous values.
 *
 * @param datoms - One or more `DatomInput` objects (or arrays of them) to convert to records
 * @returns An array of records, one per unique entity ID, mapping attributes to values
 *
 * @example
 * // Single entity from datoms
 * const result = records(
 *   { e: 1, a: "name", v: "Alice", op: "assert" },
 *   { e: 1, a: "age", v: 30, op: "assert" }
 * );
 * // Returns: [{ name: "Alice", age: 30 }]
 *
 * @example
 * // Multiple entities
 * const result = records(
 *   { e: 1, a: "name", v: "Alice", op: "assert" },
 *   { e: 2, a: "name", v: "Bob", op: "assert" }
 * );
 * // Returns: [{ name: "Alice" }, { name: "Bob" }]
 *
 * @example
 * // Array of datoms
 * const datoms = [
 *   { e: 1, a: "name", v: "Alice", op: "assert" },
 *   { e: 1, a: "age", v: 30, op: "assert" },
 *   { e: 2, a: "name", v: "Bob", op: "assert" }
 * ];
 * const result = records(datoms);
 * // Returns: [{ name: "Alice", age: 30 }, { name: "Bob" }]
 *
 * @example
 * // Mixed datoms and arrays
 * const result = records(
 *   { e: 1, a: "name", v: "Alice", op: "assert" },
 *   [
 *     { e: 2, a: "name", v: "Bob", op: "assert" },
 *     { e: 3, a: "name", v: "Charlie", op: "assert" }
 *   ]
 * );
 * // Returns: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }]
 *
 * @example
 * // Round-trip conversion
 * const original = { entityId: 1, name: "Alice", age: 30 };
 * const datomsArray = datoms(original);
 * const reconstructed = records(datomsArray);
 * // reconstructed[0] will have { name: "Alice", age: 30 }
 * // (note: entityId is not included in the reconstructed record)
 */
export const records = (
  ...datoms: (DatomInput | DatomInput[])[]
): Record<Attribute, Value>[] => {
  // Flattens all arguments (which can be records or arrays of them) into a flat array of records
  const flatRecords: DatomInput[] = datoms.flatMap((item) =>
    Array.isArray(item) ? item : [item]
  );

  // Convert each datom to a plain object mapping attribute to value (grouped by entity)
  const entityMap = new Map<EntityId, Record<Attribute, Value>>();

  for (const datom of flatRecords) {
    if (!entityMap.has(datom.e)) {
      entityMap.set(datom.e, {});
    }
    const record = entityMap.get(datom.e)!;
    record[datom.a] = datom.v;
  }

  return Array.from(entityMap.values());
};
