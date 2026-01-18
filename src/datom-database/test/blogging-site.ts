import {
  records,
  type Attribute,
  type Datom,
  type Value,
} from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import type { DatomDatabase } from "../datom-database.js";
import type { Hook } from "../hook/hook.js";
import { HookValidator } from "../hook/validator.js";

// Schema constants
export const USER_TYPE = "user/type";
export const USER_NAME = "user/name";
export const USER_EMAIL = "user/email";
export const POST_TITLE = "post/title";
export const POST_CONTENT = "post/content";
export const POST_STATUS = "post/status";
export const POST_AUTHOR = "post/author";
export const POST_CREATED_AT = "post/createdAt";
export const POST_UPDATED_AT = "post/updatedAt";
export const TAG_NAME = "tag/name";
export const POST_TAG = "post/tag";

// User types
export const USER_TYPE_ADMIN = "admin";
export const USER_TYPE_AUTHOR = "author";
export const USER_TYPE_READER = "reader";

// Post statuses
export const POST_STATUS_DRAFT = "draft";
export const POST_STATUS_PUBLISHED = "published";

// ============================================================================
// Hooks
// ============================================================================

/**
 * Post access control hook
 * Filters post datoms based on user role and ownership:
 * - Admins can see all posts
 * - Authors can see their own posts (published or draft)
 * - Authors can see published posts from other authors
 * - Readers can only see published posts
 */
export const POST_ACCESS_CONTROL: Hook = {
  type: "afterRead",
  name: "post-access-control",
  async execute(datoms, ctx) {
    const { db } = ctx;
    const userId = ctx.userId as number | undefined;
    const userType = ctx.userType as string | undefined;

    // If no user context, block all posts
    if (!userId || !userType) {
      return {
        datoms: datoms.filter((d: Datom) => d.a !== POST_TITLE),
      };
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

    // Group post datoms by entity ID
    const postEntities = new Set<EntityId>(postDatoms.map((d) => d.e));
    const postData = new Map<EntityId, Record<Attribute, Value>>();

    // Convert post datoms to records grouped by entity
    for (const postId of postEntities) {
      const entityDatoms = postDatoms.filter((d) => d.e === postId);
      const entityRecords = records(entityDatoms);
      if (entityRecords.length > 0) {
        postData.set(postId, entityRecords[0]!);
      }
    }

    // Fetch missing author/status information from database for posts that don't have it
    for (const postId of postEntities) {
      const data = postData.get(postId) || {};
      if (!(POST_AUTHOR in data) || !(POST_STATUS in data)) {
        const postEntityDatoms = await db.datoms({ e: postId });
        const existingRecords = records(postEntityDatoms);
        if (existingRecords.length > 0) {
          // Merge existing record data into current data
          Object.assign(data, existingRecords[0]);
          postData.set(postId, data);
        }
      }
    }

    // Filter posts based on access rules
    const allowedPosts = new Set<EntityId>();
    for (const [postId, data] of postData.entries()) {
      const author = data[POST_AUTHOR] as number | undefined;
      const status = data[POST_STATUS] as string | undefined;

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
    const filteredPostDatoms = postDatoms.filter((d) => allowedPosts.has(d.e));

    return {
      datoms: [...nonPostDatoms, ...filteredPostDatoms],
    };
  },
};

/**
 * Post validator hook
 * Validates that posts have required fields: title, author, and status
 */
export const POST_VALIDATOR: Hook = {
  type: "beforeWrite",
  name: "post-validator",
  async execute(tx, ctx) {
    const { db } = ctx;
    const validator = new HookValidator();

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
      const postRecord = records(postDatoms)[0] || {};
      const hasTitle = POST_TITLE in postRecord;
      const hasAuthor = POST_AUTHOR in postRecord;
      const hasStatus = POST_STATUS in postRecord;

      // Check existing datoms for posts being updated
      const existingDatoms = await db.datoms({ e: postId });
      const existingRecord = records(existingDatoms)[0] || {};
      const existingHasTitle = POST_TITLE in existingRecord;
      const existingHasAuthor = POST_AUTHOR in existingRecord;
      const existingHasStatus = POST_STATUS in existingRecord;

      const finalHasTitle = hasTitle || existingHasTitle;
      const finalHasAuthor = hasAuthor || existingHasAuthor;
      const finalHasStatus = hasStatus || existingHasStatus;

      validator.assert(
        finalHasTitle,
        "Post must have a title",
        "MISSING_TITLE",
        postDatoms.find((d) => d.e === postId)
      );
      validator.assert(
        finalHasAuthor,
        "Post must have an author",
        "MISSING_AUTHOR",
        postDatoms.find((d) => d.e === postId)
      );
      validator.assert(
        finalHasStatus,
        "Post must have a status",
        "MISSING_STATUS",
        postDatoms.find((d) => d.e === postId)
      );
    }

    if (validator.hasErrors()) {
      return { tx, errors: validator.getErrors() };
    }

    return { tx };
  },
};

/**
 * Author validator hook
 * Validates that post authors are either authors or admins
 */
export const AUTHOR_VALIDATOR: Hook = {
  type: "beforeWrite",
  name: "author-validator",
  async execute(tx, ctx) {
    const { db } = ctx;
    const validator = new HookValidator();

    // Find all post author assignments
    for (const datom of tx.datoms) {
      if (datom.a === POST_AUTHOR && datom.op === "assert") {
        const authorId = datom.v as number;
        const authorDatoms = await db.datoms({ e: authorId });
        const authorRecord = records(authorDatoms)[0] || {};
        const userType = authorRecord[USER_TYPE] as string | undefined;
        const isAuthor = userType === USER_TYPE_AUTHOR;
        const isAdmin = userType === USER_TYPE_ADMIN;

        validator.assert(
          isAuthor || isAdmin,
          `User ${authorId} is not an author or admin`,
          "INVALID_AUTHOR",
          datom
        );
      }
    }

    if (validator.hasErrors()) {
      return { tx, errors: validator.getErrors() };
    }

    return { tx };
  },
};

export const registerHooks = (db: DatomDatabase) => {
  db.hook(POST_ACCESS_CONTROL);
  db.hook(POST_VALIDATOR);
  db.hook(AUTHOR_VALIDATOR);
};
