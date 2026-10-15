import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Same local fallback as client.ts — keeps `npm run db:migrate` working out
// of the box against the default docker-compose Postgres without requiring
// DATABASE_URL to be exported manually first.
const DEFAULT_CONNECTION_STRING = "postgresql://erp:erp_dev_password@localhost:5432/erp";

// Resolved from this file rather than the process cwd, so the same call works
// from the CLI (cwd packages/db), from the api container's start command (cwd
// /app) and from the test setup (cwd apps/api).
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

// Applies every migration the target database has not seen yet. Idempotent:
// drizzle records what it has run in drizzle.__drizzle_migrations and skips
// the rest, so calling this on every start is a no-op after the first time.
// On an empty database this is the whole install — the migrations create the
// schema *and* seed the company_info singleton, the number series and the base
// units. (The `***` fallback location is not seeded here; stock's
// location-resolver creates it on first use.)
export async function runMigrations(connectionString?: string) {
  const client = postgres(connectionString ?? process.env.DATABASE_URL ?? DEFAULT_CONNECTION_STRING, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}
