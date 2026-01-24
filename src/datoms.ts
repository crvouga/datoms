/**
 * Core datom types and utilities
 */

import type {EntityId} from './entity-id';

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
 * - Nullability: `null`, `undefined` (for optional attributes)
 * - References: `EntityId` (number | string) for entity relationships
 *
 * **Note:** `EntityId` is included here to allow referencing other entities as values.
 * Since `EntityId` can be `number | string`, numeric entity IDs overlap with
 * the `number` type, which is intentional and handled correctly by TypeScript.
 *
 * @example
 * // Valid values in datoms:
 * { e: 1, a: "name", v: "Alice", op: true }                    // string
 * { e: 1, a: "age", v: 30, op: true }                          // number
 * { e: 1, a: "active", v: true, op: true }                      // boolean
 * { e: 1, a: "middleName", v: null, op: true }                 // null
 * { e: 1, a: "optional", v: undefined, op: true }              // undefined
 * { e: 1, a: "parent", v: 42, op: true }                       // EntityId (number)
 * { e: 1, a: "owner", v: "user-123", op: true }               // EntityId (string)
 */
export type Value = string | number | boolean | null | undefined | EntityId;

/**
 * Converts an unknown input into a valid `Value` type for datoms.
 *
 * Checks if the provided value matches one of the supported datom value types:
 * - string
 * - number
 * - boolean
 * - null
 * - undefined
 *
 * If the input is not one of these types, returns `null`.
 *
 * @param v - The input value of unknown type.
 * @returns The value as a `Value` type, or `null` if not compatible.
 */
export function value(v: unknown): Value {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  if (v === null) return null;
  if (v === undefined) return undefined;
  return null;
}

/**
 * A transaction ID
 */
export type TransactionId = number;

export type Transaction = {
  tx: TransactionId;
  txSeq: number;
};

/**
 * A datom represents a fact: { e: entity, a: attribute, v: value, tx: transaction, op: true | false }
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
  /** The operation type (true or false) */
  op: boolean;
};

export function validateDatoms(datoms: DatomInput[]): void {
  for (const datom of datoms) {
    if (datom.e === null || datom.e === undefined) {
      throw new Error('Datom must have an entity ID');
    }
    if (datom.a === null || datom.a === undefined) {
      throw new Error('Datom must have an attribute');
    }
  }
}

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
  /** The operation type (true or false) */
  op: boolean;
};

/**
 * Converts records with an `entityId` property into an array of `DatomInput` objects.
 *
 * This utility function simplifies the creation of datoms from object records by automatically
 * converting each property (except `entityId`) into a datom with `op: true`.
 *
 * **Features:**
 * - Accepts variadic arguments (multiple records or arrays of records)
 * - Flattens nested arrays automatically
 * - Converts each property to a datom attribute-value pair
 * - Uses the record's `entityId` as the entity ID for all generated datoms
 * - Sets operation to `true` for all generated datoms
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
 * //   { e: 1, a: "entityId", v: 1, op: true },
 * //   { e: 1, a: "name", v: "Alice", op: true },
 * //   { e: 1, a: "age", v: 30, op: true },
 * //   { e: 1, a: "active", v: true, op: true }
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
 * // Usage with template function
 * const datoms = datoms({ e: (r) => r.id }, { id: 1, name: "Alice" });
 *
 * @example
 * // Usage in a transaction
 * await db.transact(
 *   datoms({
 *     entityId: 1,
 *     "blogging.user/type": USER_TYPE_ADMIN,
 *     "blogging.user/name": "Admin User",
 *     "user/email": "admin@example.com"
 *   })
 * );
 */

// Overload for records with entityId property
export function datoms<T extends Record<string, unknown> & {entityId: EntityId}>(
  ...records: (T | T[] | null | undefined)[]
): DatomInput[];

// Overload for template function
export function datoms<T extends Record<string, unknown>>(
  datomTemplate: {e: (r: T) => EntityId; op?: boolean},
  ...records: (T | null | undefined | (T | null | undefined)[] | null | undefined)[]
): DatomInput[];

// Implementation
export function datoms<T extends Record<string, unknown>>(
  first: T | T[] | {e: (r: T) => EntityId; op?: boolean} | null | undefined,
  ...rest: (T | T[] | null | undefined)[]
): DatomInput[] {
  // Check if first argument is a template object
  if (
    first != null &&
    typeof first === 'object' &&
    !Array.isArray(first) &&
    'e' in first &&
    typeof first.e === 'function'
  ) {
    // Template function API
    const template = first as {e: (r: T) => EntityId; op?: boolean};
    const records = rest;
    return records.flatMap(r =>
      (Array.isArray(r) ? r : [r]).flatMap(r => {
        if (r == null) return [];
        if (typeof r !== 'object') return [];
        const datoms: DatomInput[] = [];
        for (const [key, value] of Object.entries(r)) {
          datoms.push({
            e: template.e(r as T),
            a: key,
            v: value as Value,
            op: template.op ?? true,
          });
        }
        return datoms;
      }),
    );
  }
  // entityId API - first argument is a record or array
  const records = [first, ...rest];
  return records.flatMap(r =>
    (Array.isArray(r) ? r : [r]).flatMap(r => {
      if (r == null) return [];
      if (typeof r !== 'object') return [];
      if (!('entityId' in r)) {
        throw new Error("Record must have an 'entityId' property or use template function API");
      }
      const entityId = r.entityId as EntityId;
      const datoms: DatomInput[] = [];
      for (const [key, value] of Object.entries(r)) {
        datoms.push({
          e: entityId,
          a: key,
          v: value as Value,
          op: true,
        });
      }
      return datoms;
    }),
  );
}

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
 *   { e: 1, a: "name", v: "Alice", op: true },
 *   { e: 1, a: "age", v: 30, op: true }
 * );
 * // Returns: [{ name: "Alice", age: 30 }]
 *
 * @example
 * // Multiple entities
 * const result = records(
 *   { e: 1, a: "name", v: "Alice", op: true },
 *   { e: 2, a: "name", v: "Bob", op: true }
 * );
 * // Returns: [{ name: "Alice" }, { name: "Bob" }]
 *
 * @example
 * // Array of datoms
 * const datoms = [
 *   { e: 1, a: "name", v: "Alice", op: true },
 *   { e: 1, a: "age", v: 30, op: true },
 *   { e: 2, a: "name", v: "Bob", op: true }
 * ];
 * const result = records(datoms);
 * // Returns: [{ name: "Alice", age: 30 }, { name: "Bob" }]
 *
 * @example
 * // Mixed datoms and arrays
 * const result = records(
 *   { e: 1, a: "name", v: "Alice", op: true },
 *   [
 *     { e: 2, a: "name", v: "Bob", op: true },
 *     { e: 3, a: "name", v: "Charlie", op: true }
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
export const records = (...datoms: (DatomInput | DatomInput[])[]): Record<Attribute, Value>[] => {
  // Flattens all arguments (which can be records or arrays of them) into a flat array of records
  const flatRecords: DatomInput[] = datoms.flatMap(item => (Array.isArray(item) ? item : [item]));

  // Convert each datom to a plain object mapping attribute to value (grouped by entity)
  const entityMap = new Map<EntityId, Record<Attribute, Value>>();

  for (const datom of flatRecords) {
    if (!entityMap.has(datom.e)) {
      entityMap.set(datom.e, {});
    }
    // biome-ignore lint/style/noNonNullAssertion: entityMap.get is guaranteed to return a value after set
    const record = entityMap.get(datom.e)!;
    record[datom.a] = datom.v;
  }

  return Array.from(entityMap.values());
};
