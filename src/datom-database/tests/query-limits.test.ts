import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { QueryResultSizeError } from "../errors.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)(
  "Query Result Size Limits (%s)",
  (_name, createFixture) => {
    let f: Fixture;

    beforeEach(async () => {
      f = await createFixture();
      await f.beforeEach();
    });

    afterEach(async () => {
      await f.afterEach();
    });

    describe("maxResultSize option", () => {
      test("should allow queries within limit", async () => {
        const { db } = f;
        for (let i = 1; i <= 5; i++) {
          await db.add([[i, "tag", `tag-${i}`]]);
        }

        const results = await db.query({
          attribute: "tag",
          maxResultSize: 10,
        });
        expect(results.length).toBeLessThanOrEqual(10);
      });

      test("should throw QueryResultSizeError when limit exceeded", async () => {
        const { db } = f;
        // Add more datoms than the limit
        for (let i = 1; i <= 10; i++) {
          await db.add([[i, "tag", `tag-${i}`]]);
        }

        try {
          await db.query({ attribute: "tag", maxResultSize: 5 });
          throw new Error("Should have thrown QueryResultSizeError");
        } catch (error) {
          expect(error).toBeInstanceOf(QueryResultSizeError);
          const sizeError = error as QueryResultSizeError;
          expect(sizeError.resultSize).toBeGreaterThan(5);
          expect(sizeError.maxResultSize).toBe(5);
          expect(sizeError.queryOptions).toBeDefined();
        }
      });

      test("should work with limit option", async () => {
        const { db } = f;
        for (let i = 1; i <= 10; i++) {
          await db.add([[i, "tag", `tag-${i}`]]);
        }

        // limit should be applied first, then maxResultSize check
        const results = await db.query({
          attribute: "tag",
          limit: 3,
          maxResultSize: 5,
        });
        expect(results.length).toBeLessThanOrEqual(3);
      });

      test("should work with filters", async () => {
        const { db } = f;
        await db.add([[1, "name", "Alice"]]);

        const results = await db.query({
          entity: 1,
          maxResultSize: 10,
        });
        expect(results.length).toBeLessThanOrEqual(10);
      });
    });
  }
);
