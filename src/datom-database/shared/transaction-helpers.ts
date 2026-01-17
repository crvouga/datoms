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
 * Retract all datoms for an entity
 */
export async function retractEntityHelper(
  datoms: DatomsProvider,
  retract: (datoms: DatomInput[]) => Promise<void>,
  entity: EntityId
): Promise<void> {
  // Get all datoms for this entity that are currently visible
  const entityDatoms = await datoms({ e: entity, added: true });

  // Retract all of them
  const retractions: DatomInput[] = entityDatoms.map((d) => [d.e, d.a, d.v]);
  await retract(retractions);
}

/**
 * Retract all values for an entity-attribute pair
 */
export async function retractAttributeHelper(
  datoms: DatomsProvider,
  retract: (datoms: DatomInput[]) => Promise<void>,
  entity: EntityId,
  attribute: string
): Promise<void> {
  // Get all current values for this entity-attribute pair
  const datomsResult = await datoms({ e: entity, a: attribute });
  if (datomsResult.length === 0) {
    return;
  }
  // Retract all existing values
  const toRetract: DatomInput[] = datomsResult.map((d) => [d.e, d.a, d.v]);
  await retract(toRetract);
}

/**
 * Upsert a value for an entity-attribute pair
 * For cardinality "one" attributes, retracts existing values first
 */
export async function upsertHelper(
  datoms: DatomsProvider,
  getAttributeDefinition: (
    attribute: string
  ) => { cardinality?: "one" | "many" } | undefined,
  retract: (datoms: DatomInput[]) => Promise<void>,
  add: (datoms: DatomInput[]) => Promise<void>,
  entity: EntityId,
  attribute: string,
  value: Value
): Promise<void> {
  const definition = getAttributeDefinition(attribute);

  // If cardinality is "one", retract existing value first
  if (definition?.cardinality === "one") {
    const existingValues = await getValuesHelper(datoms, entity, attribute);
    const toRetract: DatomInput[] = existingValues.map((v) => [
      entity,
      attribute,
      v,
    ]);
    if (toRetract.length > 0) {
      await retract(toRetract);
    }
  }

  // Add the new value
  await add([[entity, attribute, value]]);
}

/**
 * Execute a transact operation (add and/or retract)
 */
export async function transactHelper(
  add: (datoms: DatomInput[]) => Promise<void>,
  retract: (datoms: DatomInput[]) => Promise<void>,
  ops: {
    add?: DatomInput[];
    retract?: DatomInput[];
  }
): Promise<void> {
  if (ops.add && ops.add.length > 0) {
    await add(ops.add);
  }
  if (ops.retract && ops.retract.length > 0) {
    await retract(ops.retract);
  }
}
