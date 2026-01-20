import { type DatomDatabase } from "../../datom-database";

export const notepad = async (db: DatomDatabase) => {
  const { data: results } = await db.query({
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
    limit: 5,
  });

  return results;
};
