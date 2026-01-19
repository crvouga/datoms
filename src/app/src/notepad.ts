import { type DatomDatabase } from "../../datom-database";


export const notepad = async (db: DatomDatabase) => {

    const results = await db.query({
        find: {
            "movie/id": ["?id"],
            "movie/title": ["?title"],
            "movie/popularity": ["?popularity"]
        },
        where: [
            {
                e: "?movie/id", a: "tmdb.movie/id", v: "?id"
            },
            {
                e: "?movie/id", a: "tmdb.movie/title", v: "?title"
            },
            {
                e: "?movie/id", a: "tmdb.movie/popularity", v: "?popularity"
            },
        ],
        orderBy: [["?popularity", "desc"]],
        limit: 100,
    });

    return results;

}