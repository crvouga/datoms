import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { datoms, type Datom } from "../../datoms.js";
import type { AfterRead, BeforeWrite } from "../interceptor/engine";
import { TransactionError } from "../datom-database.js";
import { InterceptorValidator } from "../interceptor/validator.js";
import { Fixture, FIXTURES } from "./fixtures.js";

// Schema constants
const USER_TYPE = "user/type";
const USER_NAME = "user/name";
const USER_EMAIL = "user/email";
const POST_TITLE = "post/title";
const POST_CONTENT = "post/content";
const POST_STATUS = "post/status";
const POST_AUTHOR = "post/author";
const POST_CREATED_AT = "post/createdAt";
const POST_UPDATED_AT = "post/updatedAt";
const TAG_NAME = "tag/name";
const POST_TAG = "post/tag";

// User types
const USER_TYPE_ADMIN = "admin";
const USER_TYPE_AUTHOR = "author";
const USER_TYPE_READER = "reader";

// Post statuses
const POST_STATUS_DRAFT = "draft";
const POST_STATUS_PUBLISHED = "published";

// ============================================================================
// Interceptors
// ============================================================================

/**
 * Post access control interceptor
 * Filters post datoms based on user role and ownership:
 * - Admins can see all posts
 * - Authors can see their own posts (published or draft)
 * - Authors can see published posts from other authors
 * - Readers can only see published posts
 */
const POST_ACCESS_CONTROL: AfterRead = {
  type: "afterRead",
  name: "post-access-control",
  async execute(datoms, ctx) {
    const { db } = ctx;
    const userId = ctx.userId as number | undefined;
    const userType = ctx.userType as string | undefined;

    // If no user context, block all posts
    if (!userId || !userType) {
      return datoms.filter((d: Datom) => d.a !== POST_TITLE);
    }

    // Get all post-related datoms
    const postDatoms = datoms.filter(
      (d: Datom) =>
        d.a === POST_TITLE ||
        d.a === POST_CONTENT ||
        d.a === POST_STATUS ||
        d.a === POST_AUTHOR
    );

    // Get non-post datoms (always allow)
    const nonPostDatoms = datoms.filter(
      (d: Datom) =>
        d.a !== POST_TITLE &&
        d.a !== POST_CONTENT &&
        d.a !== POST_STATUS &&
        d.a !== POST_AUTHOR
    );

    // Build a map of post entities and their attributes
    const postEntities = new Set<number>();
    const postData = new Map<
      number,
      {
        author?: number;
        status?: string;
        title?: string;
        content?: string;
      }
    >();

    for (const datom of postDatoms) {
      postEntities.add(datom.e as number);
      if (!postData.has(datom.e as number)) {
        postData.set(datom.e as number, {});
      }
      const data = postData.get(datom.e as number)!;
      if (datom.a === POST_AUTHOR) {
        data.author = datom.v as number;
      } else if (datom.a === POST_STATUS) {
        data.status = datom.v as string;
      } else if (datom.a === POST_TITLE) {
        data.title = datom.v as string;
      } else if (datom.a === POST_CONTENT) {
        data.content = datom.v as string;
      }
    }

    // Fetch missing author/status information from database for posts that don't have it
    for (const postId of postEntities) {
      const data = postData.get(postId)!;
      if (data.author === undefined || data.status === undefined) {
        const postEntityDatoms = await db.datoms({ e: postId });
        for (const datom of postEntityDatoms) {
          if (datom.a === POST_AUTHOR && data.author === undefined) {
            data.author = datom.v as number;
          } else if (datom.a === POST_STATUS && data.status === undefined) {
            data.status = datom.v as string;
          }
        }
      }
    }

    // Filter posts based on access rules
    const allowedPosts = new Set<number>();
    for (const [postId, data] of postData.entries()) {
      const author = data.author;
      const status = data.status;

      // Admins can see all posts
      if (userType === USER_TYPE_ADMIN) {
        allowedPosts.add(postId);
      }
      // Authors can see their own posts (published or draft)
      else if (userType === USER_TYPE_AUTHOR && author === userId) {
        allowedPosts.add(postId);
      }
      // Readers can only see published posts
      else if (
        userType === USER_TYPE_READER &&
        status === POST_STATUS_PUBLISHED
      ) {
        allowedPosts.add(postId);
      }
      // Authors can see published posts from others
      else if (
        userType === USER_TYPE_AUTHOR &&
        status === POST_STATUS_PUBLISHED
      ) {
        allowedPosts.add(postId);
      }
    }

    // Filter datoms to only include allowed posts
    const filteredPostDatoms = postDatoms.filter((d) =>
      allowedPosts.has(d.e as number)
    );

    return [...nonPostDatoms, ...filteredPostDatoms];
  },
};

/**
 * Post validator interceptor
 * Validates that posts have required fields: title, author, and status
 */
const POST_VALIDATOR: BeforeWrite = {
  type: "beforeWrite",
  name: "post-validator",
  async execute(tx, ctx) {
    const { db } = ctx;

    const validator = new InterceptorValidator();

    // Find all post entities being created/updated
    const postEntities = new Set<number>();
    for (const datom of tx.datoms) {
      if (
        datom.a === POST_TITLE ||
        datom.a === POST_CONTENT ||
        datom.a === POST_STATUS ||
        datom.a === POST_AUTHOR
      ) {
        postEntities.add(datom.e as number);
      }
    }

    // Validate each post entity
    for (const postId of postEntities) {
      const postDatoms = tx.datoms.filter((d) => d.e === postId);
      const hasTitle = postDatoms.some((d) => d.a === POST_TITLE);
      const hasAuthor = postDatoms.some((d) => d.a === POST_AUTHOR);
      const hasStatus = postDatoms.some((d) => d.a === POST_STATUS);

      // Check existing datoms for posts being updated
      const existingDatoms = await db.datoms({ e: postId });
      const existingHasTitle = existingDatoms.some((d) => d.a === POST_TITLE);
      const existingHasAuthor = existingDatoms.some((d) => d.a === POST_AUTHOR);
      const existingHasStatus = existingDatoms.some((d) => d.a === POST_STATUS);

      const finalHasTitle = hasTitle || existingHasTitle;
      const finalHasAuthor = hasAuthor || existingHasAuthor;
      const finalHasStatus = hasStatus || existingHasStatus;

      if (!finalHasTitle) {
        validator.assert(
          false,
          "Post must have a title",
          "MISSING_TITLE",
          postDatoms.find((d) => d.e === postId)
        );
      }

      if (!finalHasAuthor) {
        validator.assert(
          false,
          "Post must have an author",
          "MISSING_AUTHOR",
          postDatoms.find((d) => d.e === postId)
        );
      }

      if (!finalHasStatus) {
        validator.assert(
          false,
          "Post must have a status",
          "MISSING_STATUS",
          postDatoms.find((d) => d.e === postId)
        );
      }
    }

    if (validator.hasErrors()) {
      return { tx, errors: validator.getErrors() };
    }

    return { tx };
  },
};

/**
 * Author validator interceptor
 * Validates that post authors are either authors or admins
 */
const AUTHOR_VALIDATOR: BeforeWrite = {
  type: "beforeWrite",
  name: "author-validator",
  async execute(tx, ctx) {
    const { db } = ctx;
    const validator = new InterceptorValidator();

    // Find all post author assignments
    for (const datom of tx.datoms) {
      if (datom.a === POST_AUTHOR && datom.op === "add") {
        const authorId = datom.v as number;
        const authorDatoms = await db.datoms({ e: authorId });
        const isAuthor = authorDatoms.some(
          (d) => d.a === USER_TYPE && d.v === USER_TYPE_AUTHOR
        );
        const isAdmin = authorDatoms.some(
          (d) => d.a === USER_TYPE && d.v === USER_TYPE_ADMIN
        );

        if (!isAuthor && !isAdmin) {
          validator.assert(
            false,
            `User ${authorId} is not an author or admin`,
            "INVALID_AUTHOR",
            datom
          );
        }
      }
    }

    if (validator.hasErrors()) {
      return { tx, errors: validator.getErrors() };
    }

    return { tx };
  },
};

describe.each(FIXTURES)("Blogging Site (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
  });

  describe("User Management", () => {
    test("should create admin user", async () => {
      const { db } = f;

      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_ADMIN,
          [USER_NAME]: "Admin User",
          "user/email": "admin@example.com",
        })
      );

      const results = await db.query({
        find: { e: ["?e"], name: ["?name"], email: ["?email"] },
        where: [
          { e: "?e", a: USER_TYPE, v: USER_TYPE_ADMIN },
          { e: "?e", a: USER_NAME, v: "?name" },
          { e: "?e", a: USER_EMAIL, v: "?email" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Admin User");
      expect(results[0].email).toBe("admin@example.com");
      await db.close();
    });

    test("should create author user", async () => {
      const { db } = f;

      await db.write(
        datoms({
          entityId: 2,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author User",
          "user/email": "author@example.com",
        })
      );

      const results = await db.query({
        find: { e: ["?e"], name: ["?name"] },
        where: [
          { e: "?e", a: USER_TYPE, v: USER_TYPE_AUTHOR },
          { e: "?e", a: USER_NAME, v: "?name" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Author User");
      await db.close();
    });

    test("should create reader user", async () => {
      const { db } = f;

      await db.write(
        datoms({
          entityId: 3,
          [USER_TYPE]: USER_TYPE_READER,
          [USER_NAME]: "Reader User",
          [USER_EMAIL]: "reader@example.com",
        })
      );

      const results = await db.query({
        find: { e: ["?e"], name: ["?name"] },
        where: [
          { e: "?e", a: USER_TYPE, v: USER_TYPE_READER },
          { e: "?e", a: USER_NAME, v: "?name" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Reader User");
      await db.close();
    });
  });

  describe("Post Creation and Management", () => {
    test("should create a draft post", async () => {
      const { db } = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create draft post
      const now = new Date().toISOString();
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "My First Post",
          [POST_CONTENT]: "This is the content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
          [POST_CREATED_AT]: now,
        })
      );

      const results = await db.query({
        find: { e: ["?e"], title: ["?title"], status: ["?status"] },
        where: [
          { e: "?e", a: POST_TITLE, v: "?title" },
          { e: "?e", a: POST_STATUS, v: "?status" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("My First Post");
      expect(results[0].status).toBe(POST_STATUS_DRAFT);
      await db.close();
    });

    test("should publish a post", async () => {
      const { db } = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create draft post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "My Post",
          [POST_CONTENT]: "Content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
        })
      );

      // Publish the post
      const now = new Date().toISOString();
      await db.write([
        { op: "sub", e: 100, a: POST_STATUS, v: POST_STATUS_DRAFT },
        ...datoms({
          entityId: 100,
          [POST_STATUS]: POST_STATUS_PUBLISHED,
          [POST_UPDATED_AT]: now,
        }),
      ]);

      const results = await db.query({
        find: { e: ["?e"], status: ["?status"] },
        where: [
          { e: "?e", a: POST_TITLE, v: "My Post" },
          { e: "?e", a: POST_STATUS, v: "?status" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(POST_STATUS_PUBLISHED);
      await db.close();
    });

    test("should edit a post", async () => {
      const { db } = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "Original Title",
          [POST_CONTENT]: "Original Content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
        })
      );

      // Edit the post
      const now = new Date().toISOString();
      await db.write([
        { op: "sub", e: 100, a: POST_TITLE, v: "Original Title" },
        { op: "sub", e: 100, a: POST_CONTENT, v: "Original Content" },
        ...datoms({
          entityId: 100,
          [POST_TITLE]: "Updated Title",
          [POST_CONTENT]: "Updated Content",
          [POST_UPDATED_AT]: now,
        }),
      ]);

      const results = await db.query({
        find: { e: ["?e"], title: ["?title"], content: ["?content"] },
        where: [
          { e: "?e", a: POST_TITLE, v: "?title" },
          { e: "?e", a: POST_CONTENT, v: "?content" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Updated Title");
      expect(results[0].content).toBe("Updated Content");
      await db.close();
    });
  });

  describe("Post Access Control with Interceptors", () => {
    test("author should see their own draft posts", async () => {
      const { db } = f;

      // Create author
      const authorId = 1;
      await db.write(
        datoms({
          entityId: authorId,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create draft post by this author
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "Draft Post",
          [POST_CONTENT]: "Content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: authorId,
        })
      );

      // Register interceptor to filter posts based on user role
      db.interceptors.register(POST_ACCESS_CONTROL);

      // Query as the author
      const results = await db.query(
        {
          find: { e: ["?e"], title: ["?title"], status: ["?status"] },
          where: [
            { e: "?e", a: POST_TITLE, v: "?title" },
            { e: "?e", a: POST_STATUS, v: "?status" },
          ],
        },
        { userId: authorId, userType: USER_TYPE_AUTHOR }
      );

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Draft Post");
      expect(results[0].status).toBe(POST_STATUS_DRAFT);
      await db.close();
    });

    test("author should NOT see other authors' draft posts", async () => {
      const { db } = f;

      // Create two authors
      const author1Id = 1;
      const author2Id = 2;
      await db.write(
        datoms(
          {
            entityId: author1Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: "Author 1",
          },
          {
            entityId: author2Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: "Author 2",
          }
        )
      );

      // Create draft post by author 2
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "Author 2's Draft",
          [POST_CONTENT]: "Content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: author2Id,
        })
      );

      // Register interceptor
      db.interceptors.register(POST_ACCESS_CONTROL);

      // Query as author 1 (should NOT see author 2's draft)
      const results = await db.query(
        {
          find: { e: ["?e"], title: ["?title"] },
          where: [{ e: "?e", a: POST_TITLE, v: "?title" }],
        },
        { userId: author1Id, userType: USER_TYPE_AUTHOR }
      );

      expect(results).toHaveLength(0);
      await db.close();
    });

    test("author should see published posts from other authors", async () => {
      const { db } = f;

      // Create two authors
      const author1Id = 1;
      const author2Id = 2;
      await db.write(
        datoms(
          {
            entityId: author1Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: "Author 1",
          },
          {
            entityId: author2Id,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: "Author 2",
          }
        )
      );

      // Create published post by author 2
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "Published Post",
          [POST_CONTENT]: "Content",
          [POST_STATUS]: POST_STATUS_PUBLISHED,
          [POST_AUTHOR]: author2Id,
        })
      );

      // Register interceptor
      db.interceptors.register(POST_ACCESS_CONTROL);

      // Query as author 1 (should see author 2's published post)
      const results = await db.query(
        {
          find: { e: ["?e"], title: ["?title"] },
          where: [{ e: "?e", a: POST_TITLE, v: "?title" }],
        },
        { userId: author1Id, userType: USER_TYPE_AUTHOR }
      );

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Published Post");
      await db.close();
    });

    test("reader should only see published posts", async () => {
      const { db } = f;

      // Create author and reader
      const authorId = 1;
      const readerId = 2;
      await db.write(
        datoms(
          {
            entityId: authorId,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: "Author",
          },
          {
            entityId: readerId,
            [USER_TYPE]: USER_TYPE_READER,
            [USER_NAME]: "Reader",
          }
        )
      );

      // Create draft and published posts
      await db.write(
        datoms(
          {
            entityId: 100,
            [POST_TITLE]: "Draft Post",
            [POST_STATUS]: POST_STATUS_DRAFT,
            [POST_AUTHOR]: authorId,
          },
          {
            entityId: 101,
            [POST_TITLE]: "Published Post",
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: authorId,
          }
        )
      );

      // Register interceptor
      db.interceptors.register(POST_ACCESS_CONTROL);

      // Query as reader (should only see published post)
      const results = await db.query(
        {
          find: { e: ["?e"], title: ["?title"], status: ["?status"] },
          where: [
            { e: "?e", a: POST_TITLE, v: "?title" },
            { e: "?e", a: POST_STATUS, v: "?status" },
          ],
        },
        { userId: readerId, userType: USER_TYPE_READER }
      );

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Published Post");
      expect(results[0].status).toBe(POST_STATUS_PUBLISHED);
      await db.close();
    });

    test("admin should see all posts", async () => {
      const { db } = f;

      // Create admin and author
      const adminId = 1;
      const authorId = 2;
      await db.write(
        datoms(
          {
            entityId: adminId,
            [USER_TYPE]: USER_TYPE_ADMIN,
            [USER_NAME]: "Admin",
          },
          {
            entityId: authorId,
            [USER_TYPE]: USER_TYPE_AUTHOR,
            [USER_NAME]: "Author",
          }
        )
      );

      // Create draft and published posts
      await db.write(
        datoms(
          {
            entityId: 100,
            [POST_TITLE]: "Draft Post",
            [POST_STATUS]: POST_STATUS_DRAFT,
            [POST_AUTHOR]: authorId,
          },
          {
            entityId: 101,
            [POST_TITLE]: "Published Post",
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: authorId,
          }
        )
      );

      // Register interceptor
      db.interceptors.register(POST_ACCESS_CONTROL);

      // Query as admin (should see all posts)
      const results = await db.query(
        {
          find: { e: ["?e"], title: ["?title"], status: ["?status"] },
          where: [
            { e: "?e", a: POST_TITLE, v: "?title" },
            { e: "?e", a: POST_STATUS, v: "?status" },
          ],
        },
        { userId: adminId, userType: USER_TYPE_ADMIN }
      );

      expect(results).toHaveLength(2);
      const titles = results.map((r) => r.title).sort();
      expect(titles).toEqual(["Draft Post", "Published Post"]);
      await db.close();
    });
  });

  describe("Post Validation with Interceptors", () => {
    test("should validate post has required fields", async () => {
      const { db } = f;

      db.interceptors.register(POST_VALIDATOR);

      // Try to create post without title (should fail)
      await expect(
        db.write(
          datoms({
            entityId: 100,
            [POST_CONTENT]: "Content",
            [POST_STATUS]: POST_STATUS_DRAFT,
            [POST_AUTHOR]: 1,
          })
        )
      ).rejects.toThrow(TransactionError);

      // Create post with all required fields (should succeed)
      await db.write(
        datoms({
          entityId: 101,
          [POST_TITLE]: "Valid Post",
          [POST_CONTENT]: "Content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: 1,
        })
      );

      const results = await db.query({
        find: { e: ["?e"], title: ["?title"] },
        where: [{ e: "?e", a: POST_TITLE, v: "?title" }],
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Valid Post");
      await db.close();
    });

    test("should validate author exists", async () => {
      const { db } = f;

      db.interceptors.register(AUTHOR_VALIDATOR);

      // Try to create post with non-existent author (should fail)
      await expect(
        db.write(
          datoms({
            entityId: 100,
            [POST_TITLE]: "Post",
            [POST_AUTHOR]: 999,
          })
        )
      ).rejects.toThrow(TransactionError);

      // Create author first
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Now create post (should succeed)
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "Post",
          [POST_AUTHOR]: 1,
        })
      );

      const results = await db.query({
        find: { e: ["?e"], title: ["?title"] },
        where: [{ e: "?e", a: POST_TITLE, v: "?title" }],
      });

      expect(results).toHaveLength(1);
      await db.close();
    });
  });

  describe("Tag Management", () => {
    test("should create tags", async () => {
      const { db } = f;

      await db.write(
        datoms(
          { entityId: 1, [TAG_NAME]: "javascript" },
          { entityId: 2, [TAG_NAME]: "typescript" },
          { entityId: 3, [TAG_NAME]: "database" }
        )
      );

      const results = await db.query({
        find: { e: ["?e"], name: ["?name"] },
        where: [
          { e: "?e", a: TAG_NAME, v: "?name" },
          { e: "?e", a: TAG_NAME, v: "javascript" },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("javascript");
      await db.close();
    });

    test("should associate tags with posts", async () => {
      const { db } = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "My Post",
          [POST_STATUS]: POST_STATUS_PUBLISHED,
          [POST_AUTHOR]: 1,
        })
      );

      // Create tags
      await db.write(
        datoms(
          { entityId: 1, [TAG_NAME]: "javascript" },
          { entityId: 2, [TAG_NAME]: "typescript" }
        )
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

      const results = await db.query({
        find: {
          e: ["?e"],
          title: ["?title"],
          tag: ["?tag"],
          tagName: ["?tagName"],
        },
        where: [
          { e: "?e", a: POST_TITLE, v: "?title" },
          { e: "?e", a: POST_TAG, v: "?tag" },
          { e: "?tag", a: TAG_NAME, v: "?tagName" },
        ],
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      const tagNames = results.map((r) => r.tagName).sort();
      expect(tagNames).toContain("javascript");
      expect(tagNames).toContain("typescript");
      await db.close();
    });

    test("should query posts by tag", async () => {
      const { db } = f;

      // Create author
      await db.write(
        datoms({
          entityId: 1,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create tags
      await db.write(
        datoms(
          { entityId: 1, [TAG_NAME]: "javascript" },
          { entityId: 2, [TAG_NAME]: "typescript" }
        )
      );

      // Create posts
      await db.write(
        datoms(
          {
            entityId: 100,
            [POST_TITLE]: "JS Post",
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: 1,
            [POST_TAG]: 1,
          },
          {
            entityId: 101,
            [POST_TITLE]: "TS Post",
            [POST_STATUS]: POST_STATUS_PUBLISHED,
            [POST_AUTHOR]: 1,
            [POST_TAG]: 2,
          }
        )
      );

      // Query posts with javascript tag
      const results = await db.query({
        find: { e: ["?e"], title: ["?title"] },
        where: [
          { e: "?e", a: POST_TITLE, v: "?title" },
          { e: "?e", a: POST_TAG, v: 1 },
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("JS Post");
      await db.close();
    });
  });

  describe("Complex Scenarios", () => {
    test("should handle full workflow: create, edit, publish, tag", async () => {
      const { db } = f;

      // Create author
      const authorId = 1;
      await db.write(
        datoms({
          entityId: authorId,
          [USER_TYPE]: USER_TYPE_AUTHOR,
          [USER_NAME]: "Author",
        })
      );

      // Create draft post
      await db.write(
        datoms({
          entityId: 100,
          [POST_TITLE]: "My Blog Post",
          [POST_CONTENT]: "Initial content",
          [POST_STATUS]: POST_STATUS_DRAFT,
          [POST_AUTHOR]: authorId,
        })
      );

      // Edit post
      await db.write([
        { op: "sub", e: 100, a: POST_CONTENT, v: "Initial content" },
        ...datoms({
          entityId: 100,
          [POST_CONTENT]: "Updated content",
        }),
      ]);

      // Create tags
      await db.write(
        datoms(
          { entityId: 1, [TAG_NAME]: "javascript" },
          { entityId: 2, [TAG_NAME]: "tutorial" }
        )
      );

      // Add tags to post
      await db.write(
        datoms(
          { entityId: 100, [POST_TAG]: 1 },
          { entityId: 100, [POST_TAG]: 2 }
        )
      );

      // Publish post
      await db.write([
        { op: "sub", e: 100, a: POST_STATUS, v: POST_STATUS_DRAFT },
        datoms({
          entityId: 100,
          [POST_STATUS]: POST_STATUS_PUBLISHED,
        }),
      ]);

      // Verify final state
      const results = await db.query({
        find: {
          e: ["?e"],
          title: ["?title"],
          content: ["?content"],
          status: ["?status"],
          tagName: ["?tagName"],
        },
        where: [
          { e: "?e", a: POST_TITLE, v: "?title" },
          { e: "?e", a: POST_CONTENT, v: "?content" },
          { e: "?e", a: POST_STATUS, v: "?status" },
          { e: "?e", a: POST_TAG, v: "?tag" },
          { e: "?tag", a: TAG_NAME, v: "?tagName" },
        ],
      });

      expect(results.length).toBeGreaterThanOrEqual(2); // At least 2 results (one per tag)
      const firstResult = results[0];
      expect(firstResult.title).toBe("My Blog Post");
      expect(firstResult.content).toBe("Updated content");
      expect(firstResult.status).toBe(POST_STATUS_PUBLISHED);
      const tagName = firstResult.tagName as string | undefined;
      expect(tagName).toBeDefined();
      if (tagName) {
        expect(["javascript", "tutorial"]).toContain(tagName);
      }
      await db.close();
    });
  });
});
