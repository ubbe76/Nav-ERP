import postgres from "postgres";
import { runMigrations } from "@navet/db";
import { assertTestDatabase } from "./assert-test-database.js";
import { TEST_WORKERS, workerDatabaseName } from "./test-workers.js";

// Runs once for the whole run, before any test file. Brings the test database
// up to the current schema so a new migration never has to be applied by hand
// before running the suite — and so a freshly created empty database works
// straight away.
//
// The guard runs first: migrating is harmless, but it must never happen
// against the development database by accident.
//
// Then every worker gets its own fresh copy of the migrated database
// (test-workers.ts): dropped and cloned from it as a template, so the copies
// start with the migrations' seeded rows (permission groups, units, the
// chart of accounts) and nothing a previous run left behind. The clone needs
// a connection that is not to the template itself, hence the maintenance
// database.
export default async function setup() {
  assertTestDatabase();
  await runMigrations();

  const url = new URL(process.env.DATABASE_URL!);
  const template = url.pathname.slice(1);
  url.pathname = "/postgres";
  const server = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    for (let worker = 1; worker <= TEST_WORKERS; worker++) {
      const name = workerDatabaseName(template, worker);
      await server.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await server.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    }
  } finally {
    await server.end();
  }
}
