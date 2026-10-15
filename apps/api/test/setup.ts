import { assertTestDatabase } from "./assert-test-database.js";

// Runs per test file. Migrating the test database happens once in
// global-setup.ts; this is only the guard, kept here as well so the check
// survives even if the global setup is ever removed or reordered.
assertTestDatabase();
