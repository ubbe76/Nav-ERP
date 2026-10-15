import { runMigrations } from "@navet/db";
import { assertTestDatabase } from "./assert-test-database.js";

// Runs once for the whole run, before any test file. Brings the test database
// up to the current schema so a new migration never has to be applied by hand
// before running the suite — and so a freshly created empty database works
// straight away.
//
// The guard runs first: migrating is harmless, but it must never happen
// against the development database by accident.
export default async function setup() {
  assertTestDatabase();
  await runMigrations();
}
