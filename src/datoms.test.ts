import {describe, expect, test} from 'bun:test';

import {datoms, records, type DatomInput} from './datoms.js';
import type {EntityId} from './entity-id.js';

describe('datoms', () => {
  describe('single record', () => {
    test('should convert a single record to datoms', () => {
      const result = datoms({
        entityId: 1,
        name: 'Alice',
        age: 30,
      });

      expect(result).toHaveLength(3);
      expect(result).toEqual([
        {e: 1, a: 'entityId', v: 1, op: 'assert'},
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'age', v: 30, op: 'assert'},
      ]);
    });

    test('should handle string entityId', () => {
      const result = datoms({
        entityId: 'user-123',
        name: 'Bob',
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.e).toBe('user-123');
      expect(result[1]?.e).toBe('user-123');
    });

    test('should handle all value types', () => {
      const result = datoms({
        entityId: 1,
        string: 'text',
        number: 42,
        boolean: true,
        nullValue: null,
        undefinedValue: undefined,
        entityRef: 999 as EntityId,
      });

      expect(result).toHaveLength(7);
      expect(result.find((d: DatomInput) => d.a === 'string')?.v).toBe('text');
      expect(result.find((d: DatomInput) => d.a === 'number')?.v).toBe(42);
      expect(result.find((d: DatomInput) => d.a === 'boolean')?.v).toBe(true);
      expect(result.find((d: DatomInput) => d.a === 'nullValue')?.v).toBe(null);
      expect(result.find((d: DatomInput) => d.a === 'undefinedValue')?.v).toBe(undefined);
      expect(result.find((d: DatomInput) => d.a === 'entityRef')?.v).toBe(999);
    });

    test("should set op to 'assert' for all datoms", () => {
      const result = datoms({
        entityId: 1,
        name: 'Alice',
        age: 30,
      });

      expect(result.every((d: DatomInput) => d.op === 'assert')).toBe(true);
    });
  });

  describe('multiple records', () => {
    test('should convert multiple records to datoms', () => {
      const result = datoms({entityId: 1, name: 'Alice'}, {entityId: 2, name: 'Bob'});

      expect(result).toHaveLength(4);
      expect(result).toEqual([
        {e: 1, a: 'entityId', v: 1, op: 'assert'},
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 2, a: 'entityId', v: 2, op: 'assert'},
        {e: 2, a: 'name', v: 'Bob', op: 'assert'},
      ]);
    });

    test('should handle records with different properties', () => {
      const result = datoms(
        {entityId: 1, name: 'Alice', age: 30},
        {entityId: 2, name: 'Bob', active: true},
      );

      expect(result).toHaveLength(6);
      expect(result.filter((d: DatomInput) => d.e === 1)).toHaveLength(3);
      expect(result.filter((d: DatomInput) => d.e === 2)).toHaveLength(3);
    });
  });

  describe('array of records', () => {
    test('should convert an array of records to datoms', () => {
      const users = [
        {entityId: 1, name: 'Alice'},
        {entityId: 2, name: 'Bob'},
      ];
      const result = datoms(users);

      expect(result).toHaveLength(4);
      expect(result.filter((d: DatomInput) => d.e === 1)).toHaveLength(2);
      expect(result.filter((d: DatomInput) => d.e === 2)).toHaveLength(2);
    });

    test('should handle empty array', () => {
      const result = datoms([]);
      expect(result).toHaveLength(0);
    });

    test('should handle array with single record', () => {
      const result = datoms([{entityId: 1, name: 'Alice'}]);
      expect(result).toHaveLength(2);
    });
  });

  describe('mixed records and arrays', () => {
    test('should handle mix of records and arrays', () => {
      const result = datoms({entityId: 1, name: 'Alice'}, [
        {entityId: 2, name: 'Bob'},
        {entityId: 3, name: 'Charlie'},
      ]);

      expect(result).toHaveLength(6);
      expect(result.filter((d: DatomInput) => d.e === 1)).toHaveLength(2);
      expect(result.filter((d: DatomInput) => d.e === 2)).toHaveLength(2);
      expect(result.filter((d: DatomInput) => d.e === 3)).toHaveLength(2);
    });

    test('should handle multiple arrays', () => {
      const result = datoms([{entityId: 1, name: 'Alice'}], [{entityId: 2, name: 'Bob'}]);

      expect(result).toHaveLength(4);
      expect(result.filter((d: DatomInput) => d.e === 1)).toHaveLength(2);
      expect(result.filter((d: DatomInput) => d.e === 2)).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    test('should handle record with only entityId', () => {
      const result = datoms({entityId: 1});
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({e: 1, a: 'entityId', v: 1, op: 'assert'});
    });

    test('should handle record with numeric keys', () => {
      const result = datoms(
        {e: r => r.entityId},
        {
          entityId: 1,
          '0': 'zero',
          '1': 'one',
        },
      );

      expect(result).toHaveLength(3);
      expect(result.find((d: DatomInput) => d.a === '0')?.v).toBe('zero');
      expect(result.find((d: DatomInput) => d.a === '1')?.v).toBe('one');
    });

    test('should handle record with special characters in keys', () => {
      const result = datoms(
        {e: r => r.entityId},
        {
          entityId: 1,
          'user/name': 'Alice',
          'user.email': 'alice@example.com',
          'user-name': 'Alice',
        },
      );

      expect(result).toHaveLength(4);
      expect(result.find((d: DatomInput) => d.a === 'user/name')?.v).toBe('Alice');
      expect(result.find((d: DatomInput) => d.a === 'user.email')?.v).toBe('alice@example.com');
      expect(result.find((d: DatomInput) => d.a === 'user-name')?.v).toBe('Alice');
    });

    test('should preserve entityId in datoms', () => {
      const result = datoms(
        {
          e: r => r.entityId,
        },
        {
          entityId: 1,
          name: 'Alice',
        },
      );

      // entityId should appear as both the entity (e) and as an attribute
      const entityIdDatom = result.find((d: DatomInput) => d.a === 'entityId');
      expect(entityIdDatom).toBeDefined();
      expect(entityIdDatom?.e).toBe(1);
      expect(entityIdDatom?.v).toBe(1);
    });
  });

  describe('type safety', () => {
    test('should return DatomInput[] type', () => {
      const result = datoms({e: r => r.entityId}, {entityId: 1, name: 'Alice'});
      // biome-ignore lint/style/noNonNullAssertion: result is guaranteed to have at least one element
      const first: DatomInput = result[0]!;
      expect(first).toBeDefined();
      expect(first.e).toBeDefined();
      expect(first.a).toBeDefined();
      expect(first.v).toBeDefined();
      expect(first.op).toBe('assert');
    });
  });
});

describe('records', () => {
  describe('single entity', () => {
    test('should convert datoms for a single entity to a record', () => {
      const result = records(
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'age', v: 30, op: 'assert'},
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({name: 'Alice', age: 30});
    });

    test('should handle single datom', () => {
      const result = records({e: 1, a: 'name', v: 'Alice', op: 'assert'});

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({name: 'Alice'});
    });

    test('should handle all value types', () => {
      const result = records(
        {e: 1, a: 'string', v: 'text', op: 'assert'},
        {e: 1, a: 'number', v: 42, op: 'assert'},
        {e: 1, a: 'boolean', v: true, op: 'assert'},
        {e: 1, a: 'nullValue', v: null, op: 'assert'},
        {e: 1, a: 'undefinedValue', v: undefined, op: 'assert'},
        {e: 1, a: 'entityRef', v: 999, op: 'assert'},
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        string: 'text',
        number: 42,
        boolean: true,
        nullValue: null,
        undefinedValue: undefined,
        entityRef: 999,
      });
    });

    test('should handle string entityId', () => {
      const result = records(
        {e: 'user-123', a: 'name', v: 'Bob', op: 'assert'},
        {e: 'user-123', a: 'age', v: 25, op: 'assert'},
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({name: 'Bob', age: 25});
    });
  });

  describe('multiple entities', () => {
    test('should convert datoms for multiple entities to separate records', () => {
      const result = records(
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 2, a: 'name', v: 'Bob', op: 'assert'},
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({name: 'Alice'});
      expect(result[1]).toEqual({name: 'Bob'});
    });

    test('should group datoms by entity ID', () => {
      const result = records(
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'age', v: 30, op: 'assert'},
        {e: 2, a: 'name', v: 'Bob', op: 'assert'},
        {e: 2, a: 'age', v: 25, op: 'assert'},
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({name: 'Alice', age: 30});
      expect(result[1]).toEqual({name: 'Bob', age: 25});
    });
  });

  describe('array of datoms', () => {
    test('should convert an array of datoms to records', () => {
      const datomsArray: DatomInput[] = [
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'age', v: 30, op: 'assert'},
        {e: 2, a: 'name', v: 'Bob', op: 'assert'},
      ];
      const result = records(datomsArray);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({name: 'Alice', age: 30});
      expect(result[1]).toEqual({name: 'Bob'});
    });

    test('should handle empty array', () => {
      const result = records([]);
      expect(result).toHaveLength(0);
    });

    test('should handle array with single datom', () => {
      const result = records([{e: 1, a: 'name', v: 'Alice', op: 'assert'}]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({name: 'Alice'});
    });
  });

  describe('mixed datoms and arrays', () => {
    test('should handle mix of datoms and arrays', () => {
      const result = records({e: 1, a: 'name', v: 'Alice', op: 'assert'}, [
        {e: 2, a: 'name', v: 'Bob', op: 'assert'},
        {e: 3, a: 'name', v: 'Charlie', op: 'assert'},
      ]);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({name: 'Alice'});
      expect(result[1]).toEqual({name: 'Bob'});
      expect(result[2]).toEqual({name: 'Charlie'});
    });

    test('should handle multiple arrays', () => {
      const result = records(
        [{e: 1, a: 'name', v: 'Alice', op: 'assert'}],
        [{e: 2, a: 'name', v: 'Bob', op: 'assert'}],
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({name: 'Alice'});
      expect(result[1]).toEqual({name: 'Bob'});
    });
  });

  describe('edge cases', () => {
    test('should handle duplicate attributes (last wins)', () => {
      const result = records(
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'name', v: 'Alicia', op: 'assert'},
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({name: 'Alicia'});
    });

    test('should handle special characters in attribute names', () => {
      const result = records(
        {e: 1, a: 'user/name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'user.email', v: 'alice@example.com', op: 'assert'},
        {e: 1, a: 'user-name', v: 'Alice', op: 'assert'},
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        'user/name': 'Alice',
        'user.email': 'alice@example.com',
        'user-name': 'Alice',
      });
    });

    test('should handle numeric attribute names', () => {
      const result = records(
        {e: 1, a: '0', v: 'zero', op: 'assert'},
        {e: 1, a: '1', v: 'one', op: 'assert'},
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({'0': 'zero', '1': 'one'});
    });

    test('should handle empty record (no datoms for entity)', () => {
      // This shouldn't happen in practice, but test the edge case
      const result = records();
      expect(result).toHaveLength(0);
    });
  });

  describe('round-trip conversion', () => {
    test('should convert records to datoms and back', () => {
      const original = {entityId: 1, name: 'Alice', age: 30};
      const datomsArray = datoms({e: r => r.entityId}, original);
      const reconstructed = records(datomsArray);

      expect(reconstructed).toHaveLength(1);
      // entityId is included as a datom, so it will be in the reconstructed record
      expect(reconstructed[0]).toMatchObject({
        entityId: 1,
        name: 'Alice',
        age: 30,
      });
    });

    test('should handle multiple entities round-trip', () => {
      const original = [
        {entityId: 1, name: 'Alice'},
        {entityId: 2, name: 'Bob'},
      ];
      const datomsArray = datoms({e: r => r.entityId}, original);
      const reconstructed = records(datomsArray);

      expect(reconstructed).toHaveLength(2);
      expect(reconstructed[0]).toMatchObject({entityId: 1, name: 'Alice'});
      expect(reconstructed[1]).toMatchObject({entityId: 2, name: 'Bob'});
    });
  });

  describe('operation type', () => {
    test("should work with 'assert' operation", () => {
      const result = records({e: 1, a: 'name', v: 'Alice', op: 'assert'});
      expect(result[0]).toEqual({name: 'Alice'});
    });

    test("should work with 'retract' operation", () => {
      const result = records({e: 1, a: 'name', v: 'Alice', op: 'retract'});
      expect(result[0]).toEqual({name: 'Alice'});
    });

    test('should handle mixed operations', () => {
      const result = records(
        {e: 1, a: 'name', v: 'Alice', op: 'assert'},
        {e: 1, a: 'age', v: 30, op: 'retract'},
      );
      // Both operations are treated the same way - just converted to records
      expect(result[0]).toEqual({name: 'Alice', age: 30});
    });
  });
});
