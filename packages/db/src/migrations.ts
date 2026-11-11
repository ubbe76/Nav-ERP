import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

// Same local fallback as client.ts — keeps `npm run db:migrate` working out
// of the box against the default docker-compose Postgres without requiring
// DATABASE_URL to be exported manually first.
const DEFAULT_CONNECTION_STRING = "postgresql://erp:erp_dev_password@localhost:5432/erp";

// Resolved from this file rather than the process cwd, so the same call works
// from the CLI (cwd packages/db), from the api container's start command (cwd
// /app) and from the test setup (cwd apps/api).
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

// Session-level advisory lock held while migrating, so two processes starting
// at once (two api containers, the api and a manual `db:migrate`) never run the
// same migration twice now that each migration commits on its own.
const MIGRATION_LOCK_KEY = 4_810_270_190;

// Applies every migration the target database has not seen yet. Idempotent:
// what has run is recorded in drizzle.__drizzle_migrations (the same table and
// the same rule as drizzle's own migrator: a migration runs when its folder
// timestamp is newer than the newest recorded one), so calling this on every
// start is a no-op after the first time. On an empty database this is the
// whole install — the migrations create the schema *and* seed the
// company_info singleton, the number series and the base units. (The `***`
// fallback location is not seeded here; stock's location-resolver creates it
// on first use.)
//
// Each migration runs in its OWN transaction — not drizzle's `migrate()`, which
// wraps every pending migration in one. Postgres refuses to use an enum value
// added in the same transaction ("New enum values must be committed before
// they can be used", 55P04), so a later migration using a value an earlier one
// added (0084 adds costing_material_source 'actual', 0187's CHECK names it)
// broke a fresh install while every upgrade one version at a time worked. A
// migration that adds an enum value and uses it in the same file still needs
// to be split in two.
export async function runMigrations(connectionString?: string) {
  // max_lifetime null: postgres.js otherwise recycles a connection after
  // 30–60 minutes, and a new connection would silently drop the session's
  // advisory lock between two migrations of a long run.
  const client = postgres(connectionString ?? process.env.DATABASE_URL ?? DEFAULT_CONNECTION_STRING, { max: 1, max_lifetime: null });
  try {
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    assertAscendingJournal(migrations.map((m) => m.folderMillis));
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await client`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `;
      const [last] = await client<{ created_at: string | null }[]>`
        select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
      `;
      const lastMillis = last?.created_at == null ? null : Number(last.created_at);
      for (const migration of migrations) {
        if (lastMillis !== null && migration.folderMillis <= lastMillis) continue;
        await client.begin(async (tx) => {
          for (const statement of migration.sql) {
            await tx.unsafe(statement);
          }
          await tx`
            insert into drizzle.__drizzle_migrations ("hash", "created_at")
            values (${migration.hash}, ${migration.folderMillis})
          `;
        });
      }
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}

// "Runs when newer than the newest recorded" only works on a strictly
// ascending journal: a migration renumbered after a merge but keeping an
// older `when` would be skipped on every upgraded database while a fresh
// install ran it (delatgranskningen 2026-11-11). Refuse before touching
// the database. Exported for its test.
export function assertAscendingJournal(folderMillis: number[]): void {
  for (let i = 1; i < folderMillis.length; i++) {
    if (!(folderMillis[i]! > folderMillis[i - 1]!)) {
      throw new Error(
        `drizzle/meta/_journal.json is not strictly ascending: entry ${i} (when ${folderMillis[i]}) is not after entry ${i - 1} (when ${folderMillis[i - 1]})`
      );
    }
  }
}
