import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import type {DatalogQuery} from '../../datalog-query.js';
import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';

describe.each(FIXTURES)('DatomDatabase (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe('Database query (Datalog)', () => {
    test('should handle multi-entity relationships (friendships)', async () => {
      const {db} = f;
      // Create people
      await db.write([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Charlie'},
        // Friendships: Alice -> Bob, Bob -> Charlie
        {op: true, e: 10, a: 'from', v: 1},
        {op: true, e: 10, a: 'to', v: 2},
        {op: true, e: 10, a: 'type', v: 'friendship'},
        {op: true, e: 11, a: 'from', v: 2},
        {op: true, e: 11, a: 'to', v: 3},
        {op: true, e: 11, a: 'type', v: 'friendship'},
      ]);

      // Find all friendships: who is friends with whom

      const found = await db.read({
        find: {from: {t: 'identity', c: '?from'}, to: {t: 'identity', c: '?to'}},
        where: [
          {t: 'match', e: '?f', a: 'from', v: '?from'},
          {t: 'match', e: '?f', a: 'to', v: '?to'},
          {t: 'match', e: '?f', a: 'type', v: 'friendship'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(2);
      const friendships = results.map(r => [r.from, r.to]);
      expect(friendships).toContainEqual([1, 2]);
      expect(friendships).toContainEqual([2, 3]);
    });

    test('should handle transitive relationships (friends of friends)', async () => {
      const {db} = f;
      // Create people and friendships
      await db.write([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Charlie'},
        {op: true, e: 4, a: 'name', v: 'Diana'},
        // Friendships: Alice -> Bob, Bob -> Charlie, Bob -> Diana
        {op: true, e: 10, a: 'from', v: 1},
        {op: true, e: 10, a: 'to', v: 2},
        {op: true, e: 11, a: 'from', v: 2},
        {op: true, e: 11, a: 'to', v: 3},
        {op: true, e: 12, a: 'from', v: 2},
        {op: true, e: 12, a: 'to', v: 4},
      ]);

      // Find friends of Alice's friends (friends of friends)
      const query: DatalogQuery = {
        find: {friendOfFriend: {t: 'identity', c: '?friendOfFriend'}},
        where: [
          {t: 'match', e: '?f1', a: 'from', v: 1},
          {t: 'match', e: '?f1', a: 'to', v: '?friend'},
          {t: 'match', e: '?f2', a: 'from', v: '?friend'},
          {t: 'match', e: '?f2', a: 'to', v: '?friendOfFriend'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(2);
      const friendOfFriends = results.map(r => r.friendOfFriend).sort();
      expect(friendOfFriends).toEqual([3, 4]);
    });

    test('should handle parent-child relationships', async () => {
      const {db} = f;
      // Create a family tree
      await db.write([
        {op: true, e: 1, a: 'name', v: 'Alice'},
        {op: true, e: 2, a: 'name', v: 'Bob'},
        {op: true, e: 3, a: 'name', v: 'Charlie'},
        {op: true, e: 4, a: 'name', v: 'Diana'},
        // Alice is parent of Bob and Charlie
        {op: true, e: 1, a: 'child', v: 2},
        {op: true, e: 1, a: 'child', v: 3},
        // Bob is parent of Diana
        {op: true, e: 2, a: 'child', v: 4},
      ]);

      // Find all parent-child pairs with names
      const query: DatalogQuery = {
        find: {
          parentName: {t: 'identity', c: '?parentName'},
          childName: {t: 'identity', c: '?childName'},
        },
        where: [
          {t: 'match', e: '?parent', a: 'name', v: '?parentName'},
          {t: 'match', e: '?parent', a: 'child', v: '?child'},
          {t: 'match', e: '?child', a: 'name', v: '?childName'},
        ],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(3);
      const relationships = results.map(r => [r.parentName, r.childName]);
      expect(relationships).toContainEqual(['Alice', 'Bob']);
      expect(relationships).toContainEqual(['Alice', 'Charlie']);
      expect(relationships).toContainEqual(['Bob', 'Diana']);
    });

    test('should handle many-to-many relationships', async () => {
      const {db} = f;
      // Create students and courses with enrollments
      await db.write([
        // Students
        {op: true, e: 100_000, a: 'person/name', v: 'Alice'},
        {op: true, e: 100_001, a: 'person/name', v: 'Bob'},
        // Courses
        {op: true, e: 200_000, a: 'course/title', v: 'Math 101'},
        {op: true, e: 200_001, a: 'course/title', v: 'CS 101'},
        // Enrollments (many-to-many)
        {op: true, e: 300_000, a: 'enrollment/student', v: 100_000},
        {op: true, e: 300_000, a: 'enrollment/course', v: 200_000},
        {op: true, e: 300_001, a: 'enrollment/student', v: 100_000},
        {op: true, e: 300_001, a: 'enrollment/course', v: 200_001},
        {op: true, e: 300_002, a: 'enrollment/student', v: 100_001},
        {op: true, e: 300_002, a: 'enrollment/course', v: 200_000},
      ]);
      const found = await db.read({
        find: {
          studentName: {t: 'identity', c: '?studentName'},
          courseTitle: {t: 'identity', c: '?courseTitle'},
        },
        where: [
          {t: 'match', e: '?enrollment', a: 'enrollment/student', v: '?person'},
          {t: 'match', e: '?enrollment', a: 'enrollment/course', v: '?course'},
          {t: 'match', e: '?person', a: 'person/name', v: '?studentName'},
          {t: 'match', e: '?course', a: 'course/title', v: '?courseTitle'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(3);
      expect(results).toContainEqual({studentName: 'Alice', courseTitle: 'Math 101'});
      expect(results).toContainEqual({studentName: 'Alice', courseTitle: 'CS 101'});
      expect(results).toContainEqual({studentName: 'Bob', courseTitle: 'Math 101'});
    });

    test('should handle multi-valued attributes', async () => {
      const {db} = f;
      await db.write([
        {op: true, e: 1, a: 'tag', v: 'red'},
        {op: true, e: 1, a: 'tag', v: 'blue'},
        {op: true, e: 1, a: 'tag', v: 'green'},
        {op: true, e: 2, a: 'tag', v: 'red'},
      ]);

      const query: DatalogQuery = {
        find: {e: {t: 'identity', c: '?e'}, tag: {t: 'identity', c: '?tag'}},
        where: [{t: 'match', e: '?e', a: 'tag', v: '?tag'}],
      };

      const found = await db.read(query);
      const results = found.data;
      expect(results).toHaveLength(4);
      const entity1Tags = results
        .filter(r => r.e === 1)
        .map(r => r.tag)
        .sort();
      expect(entity1Tags).toEqual(['blue', 'green', 'red']);
    });
  });
});
