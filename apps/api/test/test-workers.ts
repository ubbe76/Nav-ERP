import { availableParallelism } from "node:os";

// Parallella testfiler: the suite runs TEST_WORKERS files at a time, each
// worker against its own copy of the test database (`<name>_w<n>`, cloned
// from the migrated test database by global-setup.ts), so one file's
// TRUNCATE never meets another file's rows. One core is left to Postgres;
// TEST_WORKERS=1 runs one file at a time, e.g. to rule out an interaction.
export const TEST_WORKERS = (() => {
  const fromEnv = Number(process.env.TEST_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;
  return Math.max(1, Math.min(4, availableParallelism() - 1));
})();

// The worker's database: the same server and credentials, the database name
// suffixed with the worker's pool id (VITEST_POOL_ID, 1…TEST_WORKERS).
export function workerDatabaseUrl(baseUrl: string, poolId: number | string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${workerDatabaseName(url.pathname.slice(1), poolId)}`;
  return url.toString();
}

export function workerDatabaseName(baseName: string, poolId: number | string): string {
  return `${baseName}_w${poolId}`;
}
