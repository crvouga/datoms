/**
 * Shared helper functions for Transaction implementations
 * These utilities provide common transaction method implementations
 */

import type { DatomInput, EntityId, QueryOptions, Value } from "../../types.js";
import type { Datom } from "../../types.js";

/**
 * Helper type for getting datoms within a transaction
 */
type DatomsProvider = (options: QueryOptions) => Promise<Datom[]>;

/**
 * Get a single value for an entity-attribute pair
 * Returns the value with the highest transaction ID (most recent)
 */
export async function getValueHelper(
  datoms: DatomsProvider,
  entity: EntityId,
  attribute: string
): Promise<Value | undefined> {
  const datomsResult = await datoms({ e: entity, a: attribute });
  if (datomsResult.length === 0) {
    return undefined;
  }
  // Return the value with the highest tx (latest value for this attribute)
  const sorted = datomsResult.sort((a, b) => b.tx - a.tx);
  return sorted[0].v;
}

/**
 * Get the most recent value for an entity-attribute pair
 * Equivalent to getValue but makes intent clearer
 */
export async function getLatestValueHelper(
  datoms: DatomsProvider,
  entity: EntityId,
  attribute: string
): Promise<Value | undefined> {
  return getValueHelper(datoms, entity, attribute);
}

/**
 * Get all values for an entity-attribute pair (for multi-valued attributes)
 */
export async function getValuesHelper(
  datoms: DatomsProvider,
  entity: EntityId,
  attribute: string
): Promise<Value[]> {
  const datomsResult = await datoms({ e: entity, a: attribute });
  return datomsResult.map((d) => d.v);
}

/**
 * Check if a fact exists
 */
export async function hasFactHelper(
  datoms: DatomsProvider,
  entity: EntityId,
  attribute: string,
  value: Value
): Promise<boolean> {
  const datomsResult = await datoms({ e: entity, a: attribute, v: value });
  return datomsResult.length > 0;
}

/**
 * Batch get values for multiple entity-attribute pairs
 */
export async function getValuesBatchHelper(
  datoms: DatomsProvider,
  queries: Array<{ entity: EntityId; attribute: string }>
): Promise<(Value | undefined)[]> {
  const results = await Promise.all(
    queries.map((q) => getValueHelper(datoms, q.entity, q.attribute))
  );
  return results;
}

/**
 * Batch get all values for multiple entity-attribute pairs (for multi-valued attributes)
 */
export async function getAllValuesBatchHelper(
  datoms: DatomsProvider,
  queries: Array<{ entity: EntityId; attribute: string }>
): Promise<Value[][]> {
  const results = await Promise.all(
    queries.map((q) => getValuesHelper(datoms, q.entity, q.attribute))
  );
  return results;
}

/**
 * Find all entities that have a specific attribute-value pair
 */
export async function findEntitiesHelper(
  datoms: DatomsProvider,
  attribute: string,
  value: Value
): Promise<EntityId[]> {
  const datomsResult = await datoms({ a: attribute, v: value });
  const entitySet = new Set<EntityId>();
  for (const datom of datomsResult) {
    entitySet.add(datom.e);
  }
  return Array.from(entitySet);
}

/**
 * sub all datoms for an entity
 */
export async function subEntityHelper(
  datoms: DatomsProvider,
  sub: (datoms: DatomInput[]) => Promise<void>,
  entity: EntityId
): Promise<void> {
  // Get all datoms for this entity that are currently visible
  const entityDatoms = await datoms({ e: entity, op: "add" }); // QueryOptions.op filters by operation type

  // sub all of them
  const subions: DatomInput[] = entityDatoms.map((d) => ({
    e: d.e,
    a: d.a,
    v: d.v,
  }));
  await sub(subions);
}

/**
 * sub all values for an entity-attribute pair
 */
export async function subAttributeHelper(
  datoms: DatomsProvider,
  sub: (datoms: DatomInput[]) => Promise<void>,
  entity: EntityId,
  attribute: string
): Promise<void> {
  // Get all current values for this entity-attribute pair
  const datomsResult = await datoms({ e: entity, a: attribute });
  if (datomsResult.length === 0) {
    return;
  }
  // sub all existing values
  const tosub: DatomInput[] = datomsResult.map((d) => ({
    e: d.e,
    a: d.a,
    v: d.v,
  }));
  await sub(tosub);
}

/**
 * Upsert a value for an entity-attribute pair
 * subs existing values first, then adds the new value
 */
export async function upsertHelper(
  datoms: DatomsProvider,
  sub: (datoms: DatomInput[]) => Promise<void>,
  add: (datoms: DatomInput[]) => Promise<void>,
  entity: EntityId,
  attribute: string,
  value: Value
): Promise<void> {
  // sub existing values first
  const existingValues = await getValuesHelper(datoms, entity, attribute);
  const tosub: DatomInput[] = existingValues.map((v) => ({
    e: entity,
    a: attribute,
    v: v,
  }));
  if (tosub.length > 0) {
    await sub(tosub);
  }

  // Add the new value
  await add([{ e: entity, a: attribute, v: value }]);
}

/**
 * Execute a transact operation (add and/or sub)
 */
export async function transactHelper(
  add: (datoms: DatomInput[]) => Promise<void>,
  sub: (datoms: DatomInput[]) => Promise<void>,
  ops: {
    add?: DatomInput[];
    sub?: DatomInput[];
  }
): Promise<void> {
  if (ops.add && ops.add.length > 0) {
    await add(ops.add);
  }
  if (ops.sub && ops.sub.length > 0) {
    await sub(ops.sub);
  }
}
