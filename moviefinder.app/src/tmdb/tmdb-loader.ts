import type { DatomDatabase } from "src";
import type { HttpClient } from "../http-client";

export class TmdbLoader {
  constructor(
    private readonly tmdbClient: HttpClient,
    private readonly db: DatomDatabase
  ) {}

  async start() {}
}
