import {datomsQueryToDatalogQuery} from '../../datoms-query.js';
import {records} from '../../datoms.js';
import type {EntityId} from '../../entity-id.js';
import type {QueryResult} from '../datom-database-view.js';
import type {DatomDatabase} from '../datom-database.js';
import type {AfterRead, Hook} from '../hook/hook.js';
import {HookValidator} from '../hook/validator.js';
import {queryResultsToDatoms} from '../shared/datoms-query-converter.js';

// Schema constants
export const USER_TYPE = 'user/type';
export const USER_NAME = 'user/name';
export const USER_EMAIL = 'user/email';
export const POST_TITLE = 'post/title';
export const POST_CONTENT = 'post/content';
export const POST_STATUS = 'post/status';
export const POST_AUTHOR = 'post/author';
export const POST_CREATED_AT = 'post/createdAt';
export const POST_UPDATED_AT = 'post/updatedAt';
export const TAG_NAME = 'tag/name';
export const POST_TAG = 'post/tag';

// User types
export const USER_TYPE_ADMIN = 'admin';
export const USER_TYPE_AUTHOR = 'author';
export const USER_TYPE_READER = 'reader';

// Post statuses
export const POST_STATUS_DRAFT = 'draft';
export const POST_STATUS_PUBLISHED = 'published';

// ============================================================================
// Hooks
// ============================================================================

/**
 * Post access control hook for query results
 * Filters post query results based on user role and ownership:
 * - Admins can see all posts
 * - Authors can see their own posts (published or draft)
 * - Authors can see published posts from other authors
 * - Readers can only see published posts
 */
export const POST_ACCESS_CONTROL: AfterRead = {
  type: 'afterRead',
  name: 'post-access-control',
  async execute(results, ctx) {
    const {db, query} = ctx;
    const userId = query.context?.userId as EntityId | undefined;
    const userType = query.context?.userType as string | undefined;

    // If no user context, block all posts
    if (!userId || !userType) {
      return {
        results: results.filter((r: Record<string, unknown>) => {
          // Filter out results that look like posts (have 'title' or 'status' fields)
          return !('title' in r) && !('status' in r);
        }) as QueryResult<typeof query.find>,
      };
    }

    // Extract post entities from results
    // Results have 'e' (entity ID) and may have 'title' and/or 'status' fields
    const postEntities = new Set<EntityId>();
    const postStatusMap = new Map<EntityId, string>();

    for (const result of results) {
      const r = result as Record<string, unknown>;
      const entityId = r.e as EntityId | undefined;
      // If result has 'title' or 'status', it's a post
      if (entityId !== undefined && ('title' in r || 'status' in r)) {
        postEntities.add(entityId);
        if ('status' in r && r.status !== undefined) {
          postStatusMap.set(entityId, r.status as string);
        }
      }
    }

    // Fetch author and status information for all posts
    // (author is never in query results, status might be missing)
    const postAuthorMap = new Map<EntityId, EntityId>();
    for (const postId of postEntities) {
      // Fetch author
      const queryAuthor = datomsQueryToDatalogQuery({e: postId, a: POST_AUTHOR});
      const {data: resultsAuthor} = await db.read(queryAuthor);
      const authorDatoms = queryResultsToDatoms(resultsAuthor, {e: postId, a: POST_AUTHOR});
      if (authorDatoms.length > 0) {
        const author = authorDatoms[0]?.v as EntityId | undefined;
        if (author !== undefined) {
          postAuthorMap.set(postId, author);
        }
      }

      // Fetch status if not already in results
      if (!postStatusMap.has(postId)) {
        const queryStatus = datomsQueryToDatalogQuery({e: postId, a: POST_STATUS});
        const {data: resultsStatus} = await db.read(queryStatus);
        const statusDatoms = queryResultsToDatoms(resultsStatus, {e: postId, a: POST_STATUS});
        if (statusDatoms.length > 0) {
          const status = statusDatoms[0]?.v as string | undefined;
          if (status !== undefined) {
            postStatusMap.set(postId, status);
          }
        }
      }
    }

    // Filter posts based on access rules
    const allowedPosts = new Set<EntityId>();
    for (const postId of postEntities) {
      const author = postAuthorMap.get(postId);
      const status = postStatusMap.get(postId);

      // Admins can see all posts
      if (userType === USER_TYPE_ADMIN) {
        allowedPosts.add(postId);
      }
      // Authors can see their own posts (published or draft)
      else if (userType === USER_TYPE_AUTHOR && author === userId) {
        allowedPosts.add(postId);
      }
      // Readers can only see published posts
      else if (userType === USER_TYPE_READER && status === POST_STATUS_PUBLISHED) {
        allowedPosts.add(postId);
      }
      // Authors can see published posts from others
      else if (userType === USER_TYPE_AUTHOR && status === POST_STATUS_PUBLISHED) {
        allowedPosts.add(postId);
      }
    }

    // Filter results to only include allowed posts
    const filteredResults = results.filter((r: Record<string, unknown>) => {
      const entityId = r.e as EntityId | undefined;
      // If it's not a post entity, allow it
      if (entityId === undefined || !postEntities.has(entityId)) {
        return true;
      }
      // If it's a post entity, check if it's allowed
      return allowedPosts.has(entityId);
    }) as QueryResult<typeof query.find>;

    return {
      results: filteredResults,
    };
  },
};

/**
 * Post validator hook
 * Validates that posts have required fields: title, author, and status
 */
export const POST_VALIDATOR: Hook = {
  type: 'beforeWrite',
  name: 'post-validator',
  async execute(tx, ctx) {
    const {db} = ctx;
    const validator = new HookValidator();

    // Find all post entities being created/updated
    const postEntities = new Set<EntityId>();
    for (const datom of tx.datoms) {
      if (
        datom.a === POST_TITLE ||
        datom.a === POST_CONTENT ||
        datom.a === POST_STATUS ||
        datom.a === POST_AUTHOR
      ) {
        postEntities.add(datom.e as EntityId);
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
      const query = datomsQueryToDatalogQuery({e: postId});
      const found = await db.read(query);
      const results = found.data;
      const existingDatoms = queryResultsToDatoms(results, {e: postId});
      const existingRecord = records(existingDatoms)[0] || {};
      const existingHasTitle = POST_TITLE in existingRecord;
      const existingHasAuthor = POST_AUTHOR in existingRecord;
      const existingHasStatus = POST_STATUS in existingRecord;

      const finalHasTitle = hasTitle || existingHasTitle;
      const finalHasAuthor = hasAuthor || existingHasAuthor;
      const finalHasStatus = hasStatus || existingHasStatus;

      validator.true(
        finalHasTitle,
        'Post must have a title',
        'MISSING_TITLE',
        postDatoms.find((d) => d.e === postId),
      );
      validator.true(
        finalHasAuthor,
        'Post must have an author',
        'MISSING_AUTHOR',
        postDatoms.find((d) => d.e === postId),
      );
      validator.true(
        finalHasStatus,
        'Post must have a status',
        'MISSING_STATUS',
        postDatoms.find((d) => d.e === postId),
      );
    }

    if (validator.hasErrors()) {
      return {tx, errors: validator.getErrors()};
    }

    return {tx};
  },
};

/**
 * Author validator hook
 * Validates that post authors are either authors or admins
 */
export const AUTHOR_VALIDATOR: Hook = {
  type: 'beforeWrite',
  name: 'author-validator',
  async execute(tx, ctx) {
    const {db} = ctx;
    const validator = new HookValidator();

    // Find all post author assignments
    for (const datom of tx.datoms) {
      if (datom.a === POST_AUTHOR && datom.op === true) {
        const authorId = datom.v as EntityId;
        const query = datomsQueryToDatalogQuery({e: authorId});
        const found = await db.read(query);
        const results = found.data;
        const authorDatoms = queryResultsToDatoms(results, {e: authorId});
        const authorRecord = records(authorDatoms)[0] || {};
        const userType = authorRecord[USER_TYPE] as string | undefined;
        const isAuthor = userType === USER_TYPE_AUTHOR;
        const isAdmin = userType === USER_TYPE_ADMIN;

        validator.true(
          isAuthor || isAdmin,
          `User ${authorId} is not an author or admin`,
          'INVALID_AUTHOR',
          datom,
        );
      }
    }

    if (validator.hasErrors()) {
      return {tx, errors: validator.getErrors()};
    }

    return {tx};
  },
};

export const registerHooks = (db: DatomDatabase) => {
  db.hook(POST_ACCESS_CONTROL);
  db.hook(POST_VALIDATOR);
  db.hook(AUTHOR_VALIDATOR);
};
