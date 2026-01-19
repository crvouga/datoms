import { beforeAll, describe, expect, it } from "bun:test";

import { FileSystemDatomDatabase } from "../filesystem/filesystem-datom-database.js";
import { expectOrderedBy } from "./expect-ordered-by.js";
import type { Fixture } from "./fixtures/fixture.js";
import { FAST_TESTS, FIXTURES } from "./fixtures/fixtures.js";

const TIMEOUT = 30000;

describe.each(FIXTURES)("Movie DB (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeAll(
    async () => {
      f = await createFixture();
      const movieDb = new FileSystemDatomDatabase({ filePath: "movie-db.csv" });
      await movieDb.initialize();
      const movieDatoms = await movieDb.datoms({
        limit: FAST_TESTS ? 500 : 1_000_000,
      });
      await f.db.transact(movieDatoms);
    },
    { timeout: TIMEOUT }
  );

  it(
    "should return the top movies by popularity",
    async () => {
      const limit = 10;
      const results = await f.db.query({
        find: {
          "movie/id": ["?id"],
          "movie/title": ["?title"],
          "movie/popularity": ["?popularity"],
          "movie/overview": ["?overview"],
        },
        where: [
          {
            e: "?id",
            a: "tmdb.movie/overview",
            v: "?overview",
          },
          {
            e: "?id",
            a: "tmdb.movie/title",
            v: "?title",
          },
          {
            e: "?id",
            a: "tmdb.movie/popularity",
            v: "?popularity",
          },
        ],
        orderBy: [["?popularity", "desc"]],
        limit: limit,
      });

      expect(results).toBeDefined();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(limit);
      expectOrderedBy(results, "movie/popularity", "desc", limit);
    },
    { timeout: TIMEOUT }
  );

  it(
    "should return movies sorted by title A to Z",
    async () => {
      const limit = 10;
      const results = await f.db.query({
        find: {
          "movie/id": ["?id"],
          "movie/title": ["?title"],
        },
        where: [
          {
            e: "?id",
            a: "tmdb.movie/title",
            v: "?title",
          },
        ],
        orderBy: [["?title", "asc"]],
        limit: limit,
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(limit);

      // Should be sorted ascending by title (A to Z)
      expectOrderedBy(results, "movie/title", "asc", limit);
    },
    { timeout: TIMEOUT }
  );

  it(
    "should return highly rated movies filtered by genre",
    async () => {
      // Filter for Action genre (genre_id: 28) and sort by vote_average descending
      const limit = 10;
      const actionGenreId = 28;

      const results = await f.db.query({
        find: {
          "movie/id": ["?id"],
          "movie/title": ["?title"],
          "movie/vote_average": ["?vote_average"],
          "movie/vote_count": ["?vote_count"],
        },
        where: [
          {
            e: "?id",
            a: "tmdb.movie/genre_id",
            v: actionGenreId,
          },
          {
            e: "?id",
            a: "tmdb.movie/title",
            v: "?title",
          },
          {
            e: "?id",
            a: "tmdb.movie/vote_average",
            v: "?vote_average",
          },
          {
            e: "?id",
            a: "tmdb.movie/vote_count",
            v: "?vote_count",
          },
        ],
        orderBy: [["?vote_average", "desc"]],
        limit: limit,
      });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(limit);
      expectOrderedBy(results, "movie/vote_average", "desc");
      for (const movie of results) {
        expect(movie["movie/id"]).toBeDefined();
        expect(movie["movie/title"]).toBeDefined();
        expect(movie["movie/vote_average"]).toBeDefined();
        expect(movie["movie/vote_count"]).toBeDefined();
        expect(typeof movie["movie/title"]).toBe("string");
        expect(typeof Number(movie["movie/vote_average"])).toBe("number");
      }
    },
    { timeout: TIMEOUT }
  );

  it(
    "should return movies sorted by vote count descending",
    async () => {
      // Get movies sorted by vote_count descending (most voted movies)
      const limit = 10;
      const results = await f.db.queryWithMetadata({
        find: {
          "movie/id": ["?id"],
          "movie/title": ["?title"],
          "movie/vote_count": ["?vote_count"],
          "movie/vote_average": ["?vote_average"],
        },
        where: [
          {
            e: "?id",
            a: "tmdb.movie/title",
            v: "?title",
          },
          {
            e: "?id",
            a: "tmdb.movie/vote_count",
            v: "?vote_count",
          },
          {
            e: "?id",
            a: "tmdb.movie/vote_average",
            v: "?vote_average",
          },
        ],
        orderBy: [["?vote_count", "desc"]],
        limit: limit,
      });
      expect(results).toBeDefined();
      expect(Array.isArray(results.data)).toBe(true);
      expect(results.data.length).toBe(limit);
      expectOrderedBy(results.data, "movie/vote_count", "desc", limit);
      for (const movie of results.data) {
        expect(movie["movie/id"]).toBeDefined();
        expect(movie["movie/title"]).toBeDefined();
        expect(movie["movie/vote_count"]).toBeDefined();
        expect(movie["movie/vote_average"]).toBeDefined();
        expect(typeof movie["movie/title"]).toBe("string");
        expect(typeof Number(movie["movie/vote_count"])).toBe("number");
        expect(Number(movie["movie/vote_count"])).toBeGreaterThanOrEqual(0);
      }
    },
    { timeout: TIMEOUT }
  );
});
