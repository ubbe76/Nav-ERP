import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, exchangeRates } from "@navet/db";
import {
  createExchangeRateService,
  ExchangeRateUnavailableError,
  RiksbankUnavailableError,
  type ExchangeRateServiceDeps,
} from "../src/modules/system/service/exchange-rates.js";

// Valutakurser: the Riksbanken client with an injected fetch — the suite
// never calls Riksbanken (test/setup.ts refuses it as well).

type Call = { url: string; headers: Record<string, string> };
type Reply = { status: number; body?: unknown } | "throw" | "hang";

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    const reply = replies.shift() ?? { status: 500 };
    if (reply === "throw") {
      // Node's fetch can put a header VALUE in the message — never logged.
      throw Object.assign(new TypeError("Invalid header value: secret-key-123"), { cause: { code: "ECONNRESET" } });
    }
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted secret-key-123"), { name: "AbortError" })));
      });
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const logged: unknown[] = [];
let now = 1_000_000;

function service(replies: Reply[], extra: Partial<ExchangeRateServiceDeps> = {}) {
  const fake = fakeFetch(replies);
  const svc = createExchangeRateService({
    db,
    fetch: fake.fetch,
    today: () => "2026-10-24",
    clock: () => now,
    log: (entry) => void logged.push(entry),
    timeoutMs: 50,
    ...extra,
  });
  return { svc, calls: fake.calls };
}

const OCTOBER = [
  { date: "2026-10-14", value: 11.158 },
  { date: "2026-10-15", value: 11.1765 },
  { date: "2026-10-16", value: 11.145 },
  { date: "2026-10-19", value: 11.104 },
  { date: "2026-10-20", value: 11.123 },
  { date: "2026-10-21", value: 11.0975 },
  { date: "2026-10-22", value: 11.112 },
  { date: "2026-10-23", value: 11.131 },
];

async function reset() {
  await db.execute(sql`TRUNCATE exchange_rates`);
  await db.execute(sql`DELETE FROM system_settings WHERE key IN ('exchange_rate_source', 'riksbank_api_key')`);
}

beforeEach(async () => {
  await reset();
  logged.length = 0;
  now += 24 * 60 * 60 * 1000;
});
afterAll(reset);

describe("getRate — Riksbanken", () => {
  it("answers SEK with 1 and never calls out", async () => {
    const { svc, calls } = service([]);
    expect(await svc.getRate("sek", "2026-10-24")).toEqual({ currency: "SEK", requestedDate: "2026-10-24", date: "2026-10-24", rate: 1, source: null });
    expect(calls).toHaveLength(0);
  });

  it("asks for [D−10, D] in one call, stores every day and answers the latest banking day ≤ D (a Saturday ⇒ Friday)", async () => {
    const { svc, calls } = service([{ status: 200, body: OCTOBER }]);
    const rate = await svc.getRate("EUR", "2026-10-24");
    expect(rate).toEqual({ currency: "EUR", requestedDate: "2026-10-24", date: "2026-10-23", rate: 11.131, source: "riksbank" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.riksbank.se/swea/v1/Observations/SEKEURPMI/2026-10-14/2026-10-24");
    expect(calls[0]!.headers).toEqual({ Accept: "application/json" });
    expect(await db.select().from(exchangeRates)).toHaveLength(8);
  });

  it("answers from the table without a call when it can prove the day — the day itself, or a weekend after it", async () => {
    const { svc: first } = service([{ status: 200, body: OCTOBER }]);
    await first.getRate("EUR", "2026-10-23");
    // A fresh service (no memo): Wednesday is stored, Sunday follows a
    // stored Friday with only a weekend in between.
    const { svc, calls } = service([]);
    expect((await svc.getRate("EUR", "2026-10-21")).rate).toBe(11.0975);
    expect(await svc.getRate("EUR", "2026-10-25")).toMatchObject({ date: "2026-10-23", rate: 11.131 });
    expect(calls).toHaveLength(0);
  });

  it("does not repeat an answered call for the same day (a holiday is otherwise indistinguishable), but asks again after the window", async () => {
    // Monday 2026-12-28 is no holiday, but Riksbanken's answer ends on the
    // Wednesday before — as for Christmas.
    const answer = [{ date: "2026-12-23", value: 11.0 }];
    const { svc, calls } = service([{ status: 200, body: answer }, { status: 200, body: answer }], { today: () => "2026-12-30" });
    expect(await svc.getRate("EUR", "2026-12-28")).toMatchObject({ date: "2026-12-23", rate: 11 });
    expect(await svc.getRate("EUR", "2026-12-28")).toMatchObject({ date: "2026-12-23", rate: 11 });
    expect(calls).toHaveLength(1);
    now += 7 * 60 * 60 * 1000;
    await svc.getRate("EUR", "2026-12-28");
    expect(calls).toHaveLength(2);
  });

  it("asks for today's rate for a day after today", async () => {
    const { svc, calls } = service([{ status: 200, body: OCTOBER }]);
    expect(await svc.getRate("EUR", "2027-01-15")).toMatchObject({ requestedDate: "2027-01-15", date: "2026-10-23", rate: 11.131 });
    expect(calls[0]!.url).toContain("/2026-10-14/2026-10-24");
  });

  it("sends the API key in Ocp-Apim-Subscription-Key when one is saved", async () => {
    const { svc, calls } = service([{ status: 200, body: OCTOBER }]);
    await svc.updateSettings({ apiKey: "my-key" }, null);
    await svc.getRate("EUR", "2026-10-24");
    expect(calls[0]!.headers).toEqual({ Accept: "application/json", "Ocp-Apim-Subscription-Key": "my-key" });
  });

  it("204 (weekend only, or a currency Riksbanken does not publish) ⇒ ExchangeRateUnavailableError", async () => {
    const { svc } = service([{ status: 204 }]);
    const error = await svc.getRate("AED", "2026-10-24").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ExchangeRateUnavailableError);
    expect((error as Error).message).toBe("Ingen kurs för AED 2026-10-24 — ange kursen själv");
    expect(await db.select().from(exchangeRates)).toHaveLength(0);
  });

  it("falls back to a manual rate in [D−10, D] when Riksbanken has none", async () => {
    const { svc } = service([{ status: 204 }]);
    await svc.createManualRate({ currency: "AED", date: "2026-10-20", rate: 3.05 }, null);
    expect(await svc.getRate("AED", "2026-10-24")).toMatchObject({ date: "2026-10-20", rate: 3.05, source: "manual" });
  });

  it("429 ⇒ unavailable, logged without the key; a manual rate still answers", async () => {
    const { svc } = service([{ status: 429, body: { statusCode: 429, message: "Rate limit is exceeded." } }, { status: 429 }]);
    await svc.updateSettings({ apiKey: "secret-key-123" }, null);
    await expect(svc.getRate("EUR", "2026-10-22")).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    expect(logged).toEqual([{ currency: "EUR", from: "2026-10-12", to: "2026-10-22", status: 429, detail: "rate limited" }]);
    await svc.createManualRate({ currency: "EUR", date: "2026-10-21", rate: 11.2 }, null);
    expect(await svc.getRate("EUR", "2026-10-22")).toMatchObject({ date: "2026-10-21", rate: 11.2, source: "manual" });
  });

  it("a transport failure and a timeout are unavailable, and err.message (which may hold the key) is never logged", async () => {
    const { svc } = service(["throw", "hang"]);
    await svc.updateSettings({ apiKey: "secret-key-123" }, null);
    await expect(svc.getRate("EUR", "2026-10-22")).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    await expect(svc.getRate("EUR", "2026-10-21")).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    expect(logged).toEqual([
      { currency: "EUR", from: "2026-10-12", to: "2026-10-22", status: 0, detail: "TypeError ECONNRESET" },
      { currency: "EUR", from: "2026-10-11", to: "2026-10-21", status: 0, detail: "AbortError" },
    ]);
    expect(JSON.stringify(logged)).not.toContain("secret");
  });

  it("an unexpected body is unavailable, never stored", async () => {
    const { svc } = service([{ status: 200, body: { date: "2026-10-23", value: 11.131 } }]);
    await expect(svc.getRate("EUR", "2026-10-23")).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    expect(await db.select().from(exchangeRates)).toHaveLength(0);
  });

  it("a manual rate for exactly the day wins over Riksbanken", async () => {
    const { svc, calls } = service([]);
    await svc.createManualRate({ currency: "EUR", date: "2026-10-23", rate: 11.25 }, null);
    expect(await svc.getRate("EUR", "2026-10-23")).toMatchObject({ rate: 11.25, source: "manual" });
    expect(calls).toHaveLength(0);
  });
});

describe("getRate — setting manual", () => {
  it("never calls Riksbanken and takes the latest manual rate in [D−10, D]", async () => {
    const { svc, calls } = service([]);
    await svc.updateSettings({ source: "manual" }, null);
    await expect(svc.getRate("EUR", "2026-10-24")).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    await svc.createManualRate({ currency: "EUR", date: "2026-10-01", rate: 11 }, null);
    await expect(svc.getRate("EUR", "2026-10-24")).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    await svc.createManualRate({ currency: "EUR", date: "2026-10-20", rate: 11.1 }, null);
    expect(await svc.getRate("EUR", "2026-10-24")).toMatchObject({ date: "2026-10-20", rate: 11.1, source: "manual" });
    expect(calls).toHaveLength(0);
  });
});

describe("manual rates, the list and Hämta från Riksbanken", () => {
  it("replaces a manual rate for the same day and audits the change", async () => {
    const entries: unknown[] = [];
    const { svc } = service([], { audit: { log: async (entry) => void entries.push(entry) } });
    const first = await svc.createManualRate({ currency: "USD", date: "2026-10-23", rate: 9.9 }, null);
    const second = await svc.createManualRate({ currency: "USD", date: "2026-10-23", rate: 9.95 }, null);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ currency: "USD", date: "2026-10-23", rate: 9.95, source: "manual" });
    expect(entries).toEqual([
      { entityType: "exchange_rate", entityId: "USD 2026-10-23", action: "created", detail: { rate: 9.9 }, userId: null },
      { entityType: "exchange_rate", entityId: "USD 2026-10-23", action: "updated", detail: { before: { rate: 9.9 }, after: { rate: 9.95 } }, userId: null },
    ]);
  });

  it("lists newest day first with filters", async () => {
    const { svc } = service([{ status: 200, body: OCTOBER }]);
    await svc.getRate("EUR", "2026-10-24");
    await svc.createManualRate({ currency: "EUR", date: "2026-10-23", rate: 11.2 }, null);
    const all = await svc.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(9);
    expect(all.rows[0]).toMatchObject({ date: "2026-10-23", source: "manual" });
    expect(all.rows[1]).toMatchObject({ date: "2026-10-23", source: "riksbank", rate: 11.131 });
    const manual = await svc.list({ limit: 50, offset: 0, source: "manual" });
    expect(manual.total).toBe(1);
    const range = await svc.list({ limit: 50, offset: 0, currency: "EUR", from: "2026-10-19", to: "2026-10-21" });
    expect(range.rows.map((row) => row.date)).toEqual(["2026-10-21", "2026-10-20", "2026-10-19"]);
  });

  it("fetches an interval in one call, clamped to today", async () => {
    const { svc, calls } = service([{ status: 200, body: OCTOBER }]);
    const result = await svc.fetchRange({ currency: "EUR", from: "2026-10-14", to: "2026-10-31" });
    expect(calls[0]!.url).toContain("/SEKEURPMI/2026-10-14/2026-10-24");
    expect(result.fetched).toBe(8);
    expect(result.rates).toHaveLength(8);
  });

  it("refuses with RiksbankUnavailableError when Riksbanken does not answer", async () => {
    const { svc } = service([{ status: 429 }, { status: 403 }]);
    const limited = await svc.fetchRange({ currency: "EUR", from: "2026-10-14", to: "2026-10-23" }).catch((err: unknown) => err);
    expect(limited).toBeInstanceOf(RiksbankUnavailableError);
    expect((limited as RiksbankUnavailableError).reason).toBe("rate_limited");
    const refused = await svc.fetchRange({ currency: "EUR", from: "2026-10-14", to: "2026-10-23" }).catch((err: unknown) => err);
    expect((refused as RiksbankUnavailableError).reason).toBe("unauthorized");
  });
});

describe("settings", () => {
  it("keeps the API key write-only: '' keeps it, null removes it, the audit sees key names only", async () => {
    const entries: unknown[] = [];
    const { svc } = service([], { audit: { log: async (entry) => void entries.push(entry) } });
    expect(await svc.viewSettings()).toEqual({ source: "riksbank", apiKeySet: false });
    expect(await svc.updateSettings({ apiKey: "very-secret", source: "manual" }, null)).toEqual({ source: "manual", apiKeySet: true });
    expect(JSON.stringify(entries)).not.toContain("very-secret");
    expect(entries[0]).toMatchObject({ entityType: "exchange_rate_settings", detail: { keys: ["exchange_rate_source", "riksbank_api_key"] } });
    await svc.updateSettings({ apiKey: "" }, null);
    expect((await svc.readSettings()).apiKey).toBe("very-secret");
    await svc.updateSettings({ apiKey: null }, null);
    expect(await svc.viewSettings()).toEqual({ source: "manual", apiKeySet: false });
  });
});
