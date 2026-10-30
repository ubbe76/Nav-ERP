import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_WORKERS } from "./test/test-workers";

// The private repo (../../private, absent in a plain clone) carries the
// end-to-end tests against the real Monitor exports; run them when it is there.
const PRIVATE_TESTS = "../../private/api-tests";
const privateInclude = existsSync(fileURLToPath(new URL(PRIVATE_TESTS, import.meta.url)))
  ? [`${PRIVATE_TESTS}/**/*.test.ts`]
  : [];

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", ...privateInclude],
    // Runs once before anything else: guards the target database, then brings
    // it up to the current schema so a new migration never has to be applied
    // by hand first.
    globalSetup: ["./test/global-setup.ts"],
    // Aborts the run unless DATABASE_URL points at a test database — the
    // suite truncates every table it touches.
    setupFiles: ["./test/setup.ts"],
    // The per-test TRUNCATE hooks used to take 2-4 s against a shared
    // Postgres and occasionally spiked well past that, which at 20 s produced
    // failures that moved between files and looked like regressions. They are
    // milliseconds now (test/helpers/fast-truncate.ts), but files run side by
    // side; the hooks are not the thing under test, so they keep the room.
    hookTimeout: 60000,
    testTimeout: 20000,
    // Integration tests truncate tables between cases, so two files must never
    // share a database: TEST_WORKERS files run at once, each worker against
    // its own clone of the test database (test/test-workers.ts,
    // global-setup.ts). One process per file, so each gets a fresh module
    // graph and its own connection pool.
    pool: "forks",
    poolOptions: { forks: { maxForks: TEST_WORKERS, minForks: 1 } },
  },
});
