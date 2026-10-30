import { assertTestDatabase } from "./assert-test-database.js";
import { workerDatabaseUrl } from "./test-workers.js";

// Parallella testfiler: this worker's own copy of the test database
// (global-setup.ts cloned it) — set before anything imports @navet/db, which
// reads DATABASE_URL once. A worker process runs one file; the base URL is
// kept so the switch is the same however often this runs.
process.env.TEST_BASE_DATABASE_URL ??= process.env.DATABASE_URL;
if (process.env.VITEST_POOL_ID && process.env.TEST_BASE_DATABASE_URL) {
  process.env.DATABASE_URL = workerDatabaseUrl(process.env.TEST_BASE_DATABASE_URL, process.env.VITEST_POOL_ID);
}

// Runs per test file. Migrating the test database happens once in
// global-setup.ts; this is only the guard, kept here as well so the check
// survives even if the global setup is ever removed or reordered.
assertTestDatabase();

// Valuta: the suite must never call Sveriges Riksbank (5 calls a minute per
// IP, and a test must not depend on the network). The exchange-rate service
// reads globalThis.fetch at call time, so a lookup that slipped through
// without an injected fetch fails here like an unreachable Riksbanken
// (ExchangeRateUnavailableError) instead of going out.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/[^/]*riksbank\.se/i.test(url)) {
    return Promise.reject(new TypeError("Riksbanken must not be called from tests — inject a fetch"));
  }
  // Fakturaskanning: the AI interpretation goes through a fake
  // (helpers/fake-invoice-interpreter.ts); only the sandbox test, run with
  // its own key in the environment, may reach Anthropic.
  if (/^https?:\/\/[^/]*anthropic\.com/i.test(url) && !process.env.ANTHROPIC_SANDBOX_API_KEY) {
    return Promise.reject(new TypeError("Anthropic must not be called from tests — inject a fake interpreter"));
  }
  return realFetch(input, init);
}) as typeof fetch;

// Städning: every TRUNCATE a test runs through db.execute becomes DELETEs of
// the same tables — same result, a few milliseconds instead of 0.1–0.4 s
// (helpers/fast-truncate.ts). Imported only now, after the guard above, and
// it is the same db instance the test file gets (setup files share the
// file's module graph).
const { db } = await import("@navet/db");
const { installFastTruncate } = await import("./helpers/fast-truncate.js");
installFastTruncate(db as unknown as Parameters<typeof installFastTruncate>[0]);
