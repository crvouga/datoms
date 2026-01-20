/**
 * EntityId utility functions
 * Pure functions for validating, serializing, and deserializing EntityId values
 * These are shared across all database implementations
 */

/**
 * A unique identifier for an entity
 */
export type EntityId = number | string;

/**
 * Validate an EntityId value
 * Checks that the EntityId is a valid type (number or string)
 * @param entityId EntityId to validate
 * @returns True if valid
 * @throws Error if invalid
 * @example
 * validateEntityId(123); // OK
 * validateEntityId("user-123"); // OK
 * validateEntityId(null); // Throws error
 */
export function validateEntityId(entityId: unknown): entityId is EntityId {
  if (typeof entityId === 'number' || typeof entityId === 'string') {
    return true;
  }
  throw new Error(`Invalid EntityId type: expected number or string, got ${typeof entityId}`);
}

/**
 * Serialize an EntityId to a string for storage
 * @param entityId EntityId to serialize
 * @returns Serialized string representation
 * @internal
 */
export function serializeEntityId(entityId: EntityId): string {
  return String(entityId);
}

/**
 * Deserialize a string to an EntityId
 * Attempts to parse numeric strings as numbers, otherwise returns as string
 * @param serialized Serialized string representation
 * @returns Deserialized EntityId
 * @internal
 */
export function deserializeEntityId(serialized: string): EntityId {
  // Try to parse as number first
  const num = Number(serialized);
  if (!isNaN(num) && isFinite(num) && String(num) === serialized) {
    return num;
  }
  return serialized;
}
