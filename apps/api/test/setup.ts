import { assertTestDatabase } from "./assert-test-database.js";

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
