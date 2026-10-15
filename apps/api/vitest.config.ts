import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    // The per-test TRUNCATE hooks take 2-4 s against a shared Postgres and
    // occasionally spike well past that, which at 20 s produced failures that
    // moved between files and looked like regressions — three in one session,
    // every one green when the file was re-run alone. The hooks are not the
    // thing under test; give them room rather than re-diagnosing flakes.
    hookTimeout: 60000,
    testTimeout: 20000,
    // Integration tests share one Postgres instance and truncate tables between
    // cases, so test files must not run concurrently against it.
    fileParallelism: false,
  },
});
