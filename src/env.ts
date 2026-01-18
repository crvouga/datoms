export const DATABASE_URL: string =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";
