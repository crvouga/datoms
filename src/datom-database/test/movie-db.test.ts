import { beforeAll, describe, expect, it } from "bun:test";

import { FileSystemDatomDatabase } from "../filesystem/filesystem-datom-database.js";
import type { Fixture } from "./fixtures/fixture.js";
import { FAST_TESTS, FIXTURES } from "./fixtures/fixtures.js";

describe.each(FIXTURES)("Movie DB (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
    const movieDb = new FileSystemDatomDatabase({ filePath: "movie-db.csv" });
    await movieDb.initialize();
    const movieDatoms = await movieDb.datoms({
      limit: FAST_TESTS ? 500 : 1_000_000,
    });
    await f.db.transact(movieDatoms);
  });

  it("should return the top movies by popularity", async () => {
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

    // Should be sorted descending by popularity
    for (let i = 1; i < limit; i++) {
      const prevPopularity = results[i - 1]?.["movie/popularity"];
      const currPopularity = results[i]?.["movie/popularity"];
      expect(prevPopularity).toBeDefined();
      expect(currPopularity).toBeDefined();
      expect(Number(prevPopularity)).toBeGreaterThanOrEqual(
        Number(currPopularity)
      );
    }
  });

  it("should return movies sorted by title A to Z", async () => {
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
    for (let i = 1; i < limit; i++) {
      const prevTitle = results[i - 1]?.["movie/title"];
      const currTitle = results[i]?.["movie/title"];
      expect(prevTitle).toBeDefined();
      expect(currTitle).toBeDefined();
      expect(
        String(prevTitle).localeCompare(String(currTitle))
      ).toBeLessThanOrEqual(0);
    }
  });
});
