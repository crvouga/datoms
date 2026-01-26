import {describe, expect, test} from 'bun:test';

import {validateEntityId, serializeEntityId, deserializeEntityId} from './entity-id.js';

describe('EntityId Validation', () => {
  describe('validateEntityId', () => {
    test('should validate string EntityIds', () => {
      expect(validateEntityId('user-123')).toBe(true);
      expect(validateEntityId('123')).toBe(true);
      expect(validateEntityId('')).toBe(true);
    });

    test('should throw error for invalid EntityIds', () => {
      expect(() => validateEntityId(null)).toThrow('Invalid EntityId');
      expect(() => validateEntityId(undefined)).toThrow('Invalid EntityId');
      expect(() => validateEntityId({})).toThrow('Invalid EntityId');
      expect(() => validateEntityId(123)).toThrow('Invalid EntityId');
    });
  });

  describe('EntityId serialization', () => {
    test('should serialize and deserialize string EntityIds', () => {
      const entityId = 'user-123';
      const serialized = serializeEntityId(entityId);
      expect(serialized).toBe('user-123');
      const deserialized = deserializeEntityId(serialized);
      expect(deserialized).toBe('user-123');
    });

    test('should handle numeric strings as strings', () => {
      const deserialized = deserializeEntityId('123');
      expect(deserialized).toBe('123');
      expect(typeof deserialized).toBe('string');
    });

    test('should handle non-numeric strings as strings', () => {
      const deserialized = deserializeEntityId('abc123');
      expect(deserialized).toBe('abc123');
      expect(typeof deserialized).toBe('string');
    });
  });
});
