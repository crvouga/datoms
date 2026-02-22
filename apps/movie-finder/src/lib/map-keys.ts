/**
 * Maps the keys of an object or entries of an array using the provided mapping function.
 *
 * @param input - An object or array to map keys for
 * @param mapper - A function that transforms keys
 * @returns A new object or array with transformed keys
 *
 * @example
 * // For objects
 * mapKeys({ foo: 1, bar: 2 }, key => `prefix_${key}`)
 * // Returns: { prefix_foo: 1, prefix_bar: 2 }
 *
 * @example
 * // For arrays of objects
 * mapKeys([{ id: 1 }, { id: 2 }], key => `movie_${key}`)
 * // Returns: [{ movie_id: 1 }, { movie_id: 2 }]
 */
export function mapKeys<T extends Record<string, unknown>>(
  input: T,
  mapper: (key: string) => string,
): T;
export function mapKeys<T extends Record<string, unknown>>(
  input: T | null | undefined,
  mapper: (key: string) => string,
): T | null | undefined;
export function mapKeys<T extends Record<string, unknown>>(
  input: T[],
  mapper: (key: string) => string,
): T[];
export function mapKeys<T extends Record<string, unknown>>(
  input: T | T[] | null | undefined,
  mapper: (key: string) => string,
): T | T[] | null | undefined {
  if (input == null) {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (item == null || typeof item !== 'object') {
        return item;
      }
      return mapKeys(item as T, mapper) as T;
    });
  }

  if (typeof input !== 'object') {
    return input;
  }

  const result = {} as T;
  for (const [key, value] of Object.entries(input)) {
    const newKey = mapper(key);
    result[newKey as keyof T] = value as T[keyof T];
  }
  return result;
}
