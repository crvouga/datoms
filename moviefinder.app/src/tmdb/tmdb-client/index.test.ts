import { describe, expect, test } from "bun:test";
import { createTmdbClient } from "./index";

describe("TmdbClient", () => {
    const client = createTmdbClient();
    if (!client) {
        console.error("Skipping tests because TmdbClient is not initialized");
        return;
    }

    test("discoverMovies", async () => {
        const result = await client.discoverMovies({ page: 1 });
        expect(result?.results).toBeInstanceOf(Array);
    });
});
