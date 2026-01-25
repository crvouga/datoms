import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {datoms} from '../../datoms.js';
import {TransactionError} from '../hook/hook.js';
import {
  AUTHOR_VALIDATOR,
  POST_ACCESS_CONTROL,
  POST_AUTHOR,
  POST_CONTENT,
  POST_CREATED_AT,
  POST_STATUS,
  POST_STATUS_DRAFT,
  POST_STATUS_PUBLISHED,
  POST_TAG,
  POST_TITLE,
  POST_UPDATED_AT,
  POST_VALIDATOR,
  TAG_NAME,
  USER_EMAIL,
  USER_NAME,
  USER_TYPE,
  USER_TYPE_ADMIN,
  USER_TYPE_AUTHOR,
  USER_TYPE_READER,
} from './blogging-site.js';
import {FIXTURES} from './fixtures/fixtures.js';
import type {Fixture} from './fixtures/fixture.js';

describe.each(FIXTURES)('Blogging Site (%s)', (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe('User Management', () => {
    test('should create admin user', async () => {
      const {db} = f;

      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_ADMIN,
          [USER_NAME]: 'Admin User',
          'user/email': 'admin@example.com',
        }),
      );

      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          name: {t: 'identity', c: '?name'},
          email: {t: 'identity', c: '?email'},
        },
        where: [
          {t: 'match', e: '?e', a: USER_TYPE, v: USER_TYPE_ADMIN},
          {t: 'match', e: '?e', a: USER_NAME, v: '?name'},
          {t: 'match', e: '?e', a: USER_EMAIL, v: '?email'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('Admin User');
      expect(results[0]?.email).toBe('admin@example.com');
    });

    test('should create author user', async () => {
      const {db} = f;

      await db.write(
        datoms({
          entityId: 2,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author User',
          'user/email': 'author@example.com',
        }),
      );

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, name: {t: 'identity', c: '?name'}},
        where: [
          {t: 'match', e: '?e', a: USER_TYPE, v: USER_TYPE_AUTHOR},
          {t: 'match', e: '?e', a: USER_NAME, v: '?name'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('Author User');
    });

    test('should create reader user', async () => {
      const {db} = f;

      await db.write(
        datoms({
          entityId: 3,
          [USER_TYPE]: USER_TYPE_READER,
          [USER_NAME]: 'Reader User',
          [USER_EMAIL]: 'reader@example.com',
        }),
      );

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, name: {t: 'identity', c: '?name'}},
        where: [
          {t: 'match', e: '?e', a: USER_TYPE, v: USER_TYPE_READER},
          {t: 'match', e: '?e', a: USER_NAME, v: '?name'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('Reader User');
    });
  });

  describe('Post Creation and Management', () => {
    test('should create a draft post', async () => {
      const {db} = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create draft post
      const now = new Date().toISOString();
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'My First Post',
          [POST_CONTENT]: 'This is the content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
          [POST_CREATED_AT]: now,
        }),
      );

      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          title: {t: 'identity', c: '?title'},
          status: {t: 'identity', c: '?status'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_STATUS, v: '?status'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('My First Post');
      expect(results[0]?.status).toBe(POST_STATUS_DRAFT);
    });

    test('should publish a post', async () => {
      const {db} = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create draft post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'My Post',
          [POST_CONTENT]: 'Content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
        }),
      );

      // Publish the post
      const now = new Date().toISOString();
      await db.write([
        {op: false, e: 100, a: POST_STATUS, v: POST_STATUS_DRAFT},
        ...datoms({
          entityId: 100,
          [POST_STATUS]: POST_STATUS_PUBLISHED,
          [POST_UPDATED_AT]: now,
        }),
      ]);

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, status: {t: 'identity', c: '?status'}},
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: 'My Post'},
          {t: 'match', e: '?e', a: POST_STATUS, v: '?status'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe(POST_STATUS_PUBLISHED);
    });

    test('should edit a post', async () => {
      const {db} = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'Original Title',
          [POST_CONTENT]: 'Original Content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
        }),
      );

      // Edit the post
      const now = new Date().toISOString();
      await db.write([
        {op: false, e: 100, a: POST_TITLE, v: 'Original Title'},
        {op: false, e: 100, a: POST_CONTENT, v: 'Original Content'},
        ...datoms({
          entityId: 100,
          [POST_TITLE]: 'Updated Title',
          [POST_CONTENT]: 'Updated Content',
          [POST_UPDATED_AT]: now,
        }),
      ]);

      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          title: {t: 'identity', c: '?title'},
          content: {t: 'identity', c: '?content'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_CONTENT, v: '?content'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Updated Title');
      expect(results[0]?.content).toBe('Updated Content');
    });
  });

  describe('Post Access Control with Hooks', () => {
    test('author should see their own draft posts', async () => {
      const {db} = f;

      // Create author
      const authorId = 1;
      await db.write(
        datoms({
          entityId: authorId,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create draft post by this author
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'Draft Post',
          [POST_CONTENT]: 'Content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: authorId,
        }),
      );

      // Register hook to filter posts based on user role
      db.hook(POST_ACCESS_CONTROL);

      // Query as the author
      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          title: {t: 'identity', c: '?title'},
          status: {t: 'identity', c: '?status'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_STATUS, v: '?status'},
        ],
        context: {userId: authorId, userType: USER_TYPE_AUTHOR},
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Draft Post');
      expect(results[0]?.status).toBe(POST_STATUS_DRAFT);
    });

    test("author should NOT see other authors' draft posts", async () => {
      const {db} = f;

      // Create two authors
      const author1Id = 1;
      const author2Id = 2;
      await db.write(
        datoms(
          {
            entityId: author1Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: 'Author 1',
          },
          {
            entityId: author2Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: 'Author 2',
          },
        ),
      );

      // Create draft post by author 2
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "Author 2's Draft",
          [POST_CONTENT]: 'Content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: author2Id,
        }),
      );

      // Register hook
      db.hook(POST_ACCESS_CONTROL);

      // Query as author 1 (should NOT see author 2's draft)
      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, title: {t: 'identity', c: '?title'}},
        where: [{t: 'match', e: '?e', a: POST_TITLE, v: '?title'}],
        context: {userId: author1Id, userType: USER_TYPE_AUTHOR},
      });
      const results = found.data;
      expect(results).toHaveLength(0);
    });

    test('author should see published posts from other authors', async () => {
      const {db} = f;

      // Create two authors
      const author1Id = 1;
      const author2Id = 2;
      await db.write(
        datoms(
          {
            entityId: author1Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: 'Author 1',
          },
          {
            entityId: author2Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: 'Author 2',
          },
        ),
      );

      // Create published post by author 2
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'Published Post',
          [POST_CONTENT]: 'Content',
          [POST_STATUS]: POST_STATUS_PUBLISHED,
          [POST_AUTHOR]: author2Id,
        }),
      );

      // Register hook
      db.hook(POST_ACCESS_CONTROL);

      // Query as author 1 (should see author 2's published post)
      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, title: {t: 'identity', c: '?title'}},
        where: [{t: 'match', e: '?e', a: POST_TITLE, v: '?title'}],
        context: {userId: author1Id, userType: USER_TYPE_AUTHOR},
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Published Post');
    });

    test('reader should only see published posts', async () => {
      const {db} = f;

      // Create author and reader
      const authorId = 1;
      const readerId = 2;
      await db.write(
        datoms(
          {
            entityId: authorId,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: 'Author',
          },
          {
            entityId: readerId,
            [USER_TYPE]: USER_TYPE_READER,
            [USER_NAME]: 'Reader',
          },
        ),
      );

      // Create draft and published posts
      await db.write(
        datoms(
          {
            entityId: 100,
            [POST_TITLE]: 'Draft Post',
            [POST_STATUS]: POST_STATUS_DRAFT,
            [POST_AUTHOR]: authorId,
          },
          {
            entityId: 101,
            [POST_TITLE]: 'Published Post',
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: authorId,
          },
        ),
      );

      // Register hook
      db.hook(POST_ACCESS_CONTROL);

      // Query as reader (should only see published post)
      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          title: {t: 'identity', c: '?title'},
          status: {t: 'identity', c: '?status'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_STATUS, v: '?status'},
        ],
        context: {userId: readerId, userType: USER_TYPE_READER},
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Published Post');
      expect(results[0]?.status).toBe(POST_STATUS_PUBLISHED);
    });

    test('admin should see all posts', async () => {
      const {db} = f;

      // Create admin and author
      const adminId = 1;
      const authorId = 2;
      await db.write(
        datoms(
          {
            entityId: adminId,
            [USER_TYPE]: USER_TYPE_ADMIN,
            [USER_NAME]: 'Admin',
          },
          {
            entityId: authorId,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: 'Author',
          },
        ),
      );

      // Create draft and published posts
      await db.write(
        datoms(
          {
            entityId: 100,
            [POST_TITLE]: 'Draft Post',
            [POST_STATUS]: POST_STATUS_DRAFT,
            [POST_AUTHOR]: authorId,
          },
          {
            entityId: 101,
            [POST_TITLE]: 'Published Post',
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: authorId,
          },
        ),
      );

      // Register hook
      db.hook(POST_ACCESS_CONTROL);

      // Query as admin (should see all posts)
      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          title: {t: 'identity', c: '?title'},
          status: {t: 'identity', c: '?status'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_STATUS, v: '?status'},
        ],
        context: {userId: adminId, userType: USER_TYPE_ADMIN},
      });
      const results = found.data;
      expect(results).toHaveLength(2);
      const titles = results.map(r => r.title).sort();
      expect(titles).toEqual(['Draft Post', 'Published Post']);
    });
  });

  describe('Post Validation with Hooks', () => {
    test('should validate post has required fields', async () => {
      const {db} = f;

      db.hook(POST_VALIDATOR);

      // Try to create post without title (should fail)
      await expect(
        db.write(
          datoms({
            entityId: 100,
            [POST_CONTENT]: 'Content',
            [POST_STATUS]: POST_STATUS_DRAFT,
            [POST_AUTHOR]: 1,
          }),
        ),
      ).rejects.toThrow(TransactionError);

      // Create post with all required fields (should succeed)
      await db.write(
        datoms({
          entityId: 101,
          [POST_TITLE]: 'Valid Post',
          [POST_CONTENT]: 'Content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
        }),
      );

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, title: {t: 'identity', c: '?title'}},
        where: [{t: 'match', e: '?e', a: POST_TITLE, v: '?title'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Valid Post');
    });

    test('should validate author exists', async () => {
      const {db} = f;

      db.hook(AUTHOR_VALIDATOR);

      // Try to create post with non-existent author (should fail)
      await expect(
        db.write(
          datoms({
            entityId: 100,
            [POST_TITLE]: 'Post',
            [POST_AUTHOR]: 999,
          }),
        ),
      ).rejects.toThrow(TransactionError);

      // Create author first
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Now create post (should succeed)
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'Post',
          [POST_AUTHOR]: 1,
        }),
      );

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, title: {t: 'identity', c: '?title'}},
        where: [{t: 'match', e: '?e', a: POST_TITLE, v: '?title'}],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
    });
  });

  describe('Tag Management', () => {
    test('should create tags', async () => {
      const {db} = f;

      await db.write(
        datoms(
          {entityId: 1, [TAG_NAME]: 'javascript'},
          {entityId: 2, [TAG_NAME]: 'typescript'},
          {entityId: 3, [TAG_NAME]: 'database'},
        ),
      );

      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, name: {t: 'identity', c: '?name'}},
        where: [
          {t: 'match', e: '?e', a: TAG_NAME, v: '?name'},
          {t: 'match', e: '?e', a: TAG_NAME, v: 'javascript'},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('javascript');
    });

    test('should associate tags with posts', async () => {
      const {db} = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'My Post',
          [POST_STATUS]: POST_STATUS_PUBLISHED,
          [POST_AUTHOR]: 1,
        }),
      );

      // Create tags
      await db.write(
        datoms({entityId: 1, [TAG_NAME]: 'javascript'}, {entityId: 2, [TAG_NAME]: 'typescript'}),
      );

      // Associate tags with post
      await db.write([
        ...datoms({
          entityId: 100,
          [POST_TAG]: 1,
        }),
        ...datoms({
          entityId: 100,
          [POST_TAG]: 2,
        }),
      ]);

      const found = await db.read({
        find: {
          e: {t: 'identity', c: '?e'},
          title: {t: 'identity', c: '?title'},
          tag: {t: 'identity', c: '?tag'},
          tagName: {t: 'identity', c: '?tagName'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_TAG, v: '?tag'},
          {t: 'match', e: '?tag', a: TAG_NAME, v: '?tagName'},
        ],
      });
      const results = found.data;
      expect(results.length).toBeGreaterThanOrEqual(2);
      const tagNames = results.map(r => r.tagName).sort();
      expect(tagNames).toContain('javascript');
      expect(tagNames).toContain('typescript');
    });

    test('should query posts by tag', async () => {
      const {db} = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create tags
      await db.write(
        datoms({entityId: 1, [TAG_NAME]: 'javascript'}, {entityId: 2, [TAG_NAME]: 'typescript'}),
      );

      // Create posts
      await db.write(
        datoms(
          {
            entityId: 100,
            [POST_TITLE]: 'JS Post',
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: 1,
            [POST_TAG]: 1,
          },
          {
            entityId: 101,
            [POST_TITLE]: 'TS Post',
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: 1,
            [POST_TAG]: 2,
          },
        ),
      );

      // Query posts with javascript tag
      const found = await db.read({
        find: {e: {t: 'identity', c: '?e'}, title: {t: 'identity', c: '?title'}},
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_TAG, v: 1},
        ],
      });
      const results = found.data;
      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('JS Post');
    });
  });

  describe('Complex Scenarios', () => {
    test('should handle full workflow: create, edit, publish, tag', async () => {
      const {db} = f;

      // Create author
      const authorId = 1;
      await db.write(
        datoms({
          entityId: authorId,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: 'Author',
        }),
      );

      // Create draft post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: 'My Blog Post',
          [POST_CONTENT]: 'Initial content',
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: authorId,
        }),
      );

      // Edit post
      await db.write([
        {op: false, e: 100, a: POST_CONTENT, v: 'Initial content'},
        ...datoms({
          entityId: 100,
          [POST_CONTENT]: 'Updated content',
        }),
      ]);

      // Create tags
      await db.write(
        datoms({entityId: 1, [TAG_NAME]: 'javascript'}, {entityId: 2, [TAG_NAME]: 'tutorial'}),
      );

      // Add tags to post
      await db.write(datoms({entityId: 100, [POST_TAG]: 1}, {entityId: 100, [POST_TAG]: 2}));

      // Publish post
      await db.write([
        {op: false, e: 100, a: POST_STATUS, v: POST_STATUS_DRAFT},
        datoms({
          entityId: 100,
          [POST_STATUS]: POST_STATUS_PUBLISHED,
        }),
      ]);

      // Verify final state
      const found = await db.read({
        find: {
          id: {t: 'identity', c: '?id'},
          title: {t: 'identity', c: '?title'},
          content: {t: 'identity', c: '?content'},
          status: {t: 'identity', c: '?status'},
          tagName: {t: 'identity', c: '?tagName'},
        },
        where: [
          {t: 'match', e: '?e', a: POST_TITLE, v: '?title'},
          {t: 'match', e: '?e', a: POST_CONTENT, v: '?content'},
          {t: 'match', e: '?e', a: POST_STATUS, v: '?status'},
          {t: 'match', e: '?e', a: POST_TAG, v: '?tag'},
          {t: 'match', e: '?tag', a: TAG_NAME, v: '?tagName'},
        ],
      });
      const results = found.data;
      expect(results.length).toBeGreaterThanOrEqual(2); // At least 2 results (one per tag)
      const firstResult = results[0];
      expect(firstResult?.title).toBe('My Blog Post');
      expect(firstResult?.content).toBe('Updated content');
      expect(firstResult?.status).toBe(POST_STATUS_PUBLISHED);
      const tagName = firstResult?.tagName as string | undefined;
      expect(tagName).toBeDefined();
      if (tagName) {
        expect(['javascript', 'tutorial']).toContain(tagName);
      }
    });
  });
});
