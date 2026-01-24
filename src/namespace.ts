/**
 * Combines a namespace, entity, and key into a single string, 
 * separated by dots and a forward slash.
 *
 * @param namespace - An array of tuples representing namespace segments.
 * @param entity - The entity name to append after the namespace.
 * @param key - The key to append after the entity.
 * @returns The composed namespace string in the format: "segment1.segment2...entity/key"
 */
export function namespaceKey(
  namespace: NonEmptyArray<string>,
  entity: string,
  key: string
): string {
  return `${namespace.join('.')}.${entity}/${key}`;
}

type NonEmptyArray<T> = [T, ...T[]];