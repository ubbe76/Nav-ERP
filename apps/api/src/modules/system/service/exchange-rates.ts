import type { Db } from "@navet/db";
import {
  SEK,
  type CreateExchangeRateInput,
  type ExchangeRateMode,
  type ExchangeRateSource,
  type FetchExchangeRatesInput,
  type ListExchangeRatesQuery,
  type UpdateExchangeRateSettingsInput,
} from "@navet/shared";
import type { AuditWriter } from "../repository/audit.repository.js";
import {
  EXCHANGE_RATE_SETTING_KEYS,
  findRateById,
  listRates,
  ratesInRange,
  readExchangeRateSettings,
  upsertManualRate,
  upsertRiksbankRates,
  writeExchangeRateSetting,
  type StoredRate,
} from "../repository/exchange-rates.js";
import { addDays, stockholmToday } from "./delivery-days.js";

// Valutakurser (Valuta, spec §1) — the ONLY file that knows Sveriges
// Riksbank's API (SWEA). Rates are SEK per 1 unit of the currency (Riksbanken
// quotes every currency per 1 unit since 2023-11-27) and are ECB's reference
// rates converted to kronor, which ML 8 kap. 21 § accepts.
//
// "The rate for day D" = the latest banking day ≤ D: Riksbanken publishes
// nothing for weekends and holidays (a single day answers 204), so a lookup
// always asks for the interval [D−10, D] in ONE call and stores every day in
// the answer. Today's rate is published around 16:15 — before that the
// latest is yesterday's. Anonymous callers get 5 calls a minute and 1000 a
// day per IP, so every answer is cached in exchange_rates and a lookup that
// the table can already answer never calls out; an optional API key
// (riksbank_api_key, write-only, header Ocp-Apim-Subscription-Key) raises
// the limit.
//
// Transport failures are never described by err.message (Node's fetch can
// echo a header VALUE — the API key — in it): the log gets the error's name
// and the cause's code only, the caller a fixed Swedish message.

export const RIKSBANK_BASE_URL = "https://api.riksbank.se/swea/v1";
const TIMEOUT_MS = 10_000;
// How far back the interval reaches: longer than any run of Swedish
// non-banking days (Christmas–New Year is at most five in a row).
export const LOOKBACK_DAYS = 10;
// A fetch that answered is not repeated for the same currency and day within
// this window — the cache keeps the observations, this remembers that the
// interval was asked for (a holiday is otherwise indistinguishable from a
// day not yet fetched). Today's interval is asked again sooner, since
// today's rate appears at 16:15.
const FETCHED_TTL_PAST_MS = 6 * 60 * 60 * 1000;
const FETCHED_TTL_TODAY_MS = 10 * 60 * 1000;
const FETCHED_MEMO_MAX = 2000;

export const RIKSBANK_MESSAGES = {
  unavailable: "Riksbanken svarar inte — försök igen eller ange kursen själv",
  rate_limited: "Riksbanken tar inte emot fler anrop just nu — försök igen om en minut eller ange kursen själv",
  unauthorized: "Riksbanken godkände inte API-nyckeln — kontrollera den under Ekonomi → Valutakurser",
  unexpected: "Riksbanken gav ett oväntat svar — försök igen eller ange kursen själv",
} as const;

export type RiksbankFailure = keyof typeof RIKSBANK_MESSAGES;

// No rate for the currency on the day: Riksbanken does not publish the
// currency, did not answer, and no manual rate covers the day. 409
// exchange-rate-unavailable — the document then needs a rate typed in.
export class ExchangeRateUnavailableError extends Error {
  constructor(
    public currency: string,
    public date: string
  ) {
    super(`Ingen kurs för ${currency} ${date} — ange kursen själv`);
    this.name = "ExchangeRateUnavailableError";
  }
}

// Hämta från Riksbanken (the explicit fetch) could not get an answer. 502
// riksbank-unavailable, or 409 for a key Riksbanken refused.
export class RiksbankUnavailableError extends Error {
  constructor(public reason: RiksbankFailure) {
    super(RIKSBANK_MESSAGES[reason]);
    this.name = "RiksbankUnavailableError";
  }
}

export type ExchangeRateLookup = {
  currency: string;
  // The day asked for, and the day of the rate that answered (the latest
  // banking day ≤ requestedDate, or the manual rate's day).
  requestedDate: string;
  date: string;
  rate: number;
  // null = SEK (always 1, never looked up).
  source: ExchangeRateSource | null;
};

// The narrow slice the document services use (supplier invoices now, the
// sales side in steg 3) — declared here, consumers depend on the interface.
export interface ExchangeRateReader {
  getRate(currency: string, date: string): Promise<ExchangeRateLookup>;
}

type Observation = { date: string; value: number };
type FetchResult = { ok: true; observations: Observation[] } | { ok: false; reason: RiksbankFailure };

export interface ExchangeRateServiceDeps {
  db: Db;
  audit?: AuditWriter;
  // Injected by every test — the suite must never call Riksbanken.
  fetch?: typeof fetch;
  timeoutMs?: number;
  // Stockholm today (YYYY-MM-DD) and a millisecond clock for the fetch memo.
  today?: () => string;
  clock?: () => number;
  log?: (entry: { currency: string; from: string; to: string; status: number; detail: string }) => void;
}

// What we log about a transport failure: the error's name and the cause's
// code — never err.message (see the header).
function transportSummary(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; cause?: { code?: unknown } | null };
  return [e.name, e.cause?.code].filter((v): v is string => typeof v === "string" && v !== "").join(" ");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

function parseObservations(text: string): Observation[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const observations: Observation[] = [];
  for (const item of data) {
    const entry = item as { date?: unknown; value?: unknown };
    if (typeof entry?.date !== "string" || !ISO_DATE.test(entry.date)) return null;
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || entry.value <= 0) return null;
    observations.push({ date: entry.date, value: Math.round(entry.value * 1e6) / 1e6 });
  }
  return observations;
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

// Every day in (after, through] is a Saturday or a Sunday — then the stored
// rate for `after` is provably the latest banking day ≤ through.
function onlyWeekendBetween(after: string, through: string): boolean {
  for (let d = addDays(after, 1); d <= through; d = addDays(d, 1)) {
    if (!isWeekend(d)) return false;
  }
  return true;
}

export function createExchangeRateService(deps: ExchangeRateServiceDeps) {
  const { db } = deps;
  const audit: AuditWriter = deps.audit ?? { log: async () => {} };
  // Call-time lookup of the global, so the test setup's guard applies.
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const today = deps.today ?? stockholmToday;
  const clock = deps.clock ?? (() => Date.now());
  const log =
    deps.log ?? ((entry) => console.warn("Riksbanken request failed", entry));

  // `${currency}|${day}` → when the interval ending on that day was fetched
  // successfully may be trusted until.
  const fetched = new Map<string, number>();
  const fetchedKey = (currency: string, day: string) => `${currency}|${day}`;
  function fetchedRecently(currency: string, day: string): boolean {
    const until = fetched.get(fetchedKey(currency, day));
    return until !== undefined && until > clock();
  }
  function markFetched(currency: string, day: string) {
    if (fetched.size >= FETCHED_MEMO_MAX) fetched.clear();
    fetched.set(fetchedKey(currency, day), clock() + (day >= today() ? FETCHED_TTL_TODAY_MS : FETCHED_TTL_PAST_MS));
  }

  async function readSettings(): Promise<{ source: ExchangeRateMode; apiKey: string | null }> {
    const raw = await readExchangeRateSettings(db);
    const apiKey = raw.get(EXCHANGE_RATE_SETTING_KEYS.apiKey);
    return {
      source: raw.get(EXCHANGE_RATE_SETTING_KEYS.source) === "manual" ? "manual" : "riksbank",
      apiKey: apiKey && apiKey !== "" ? apiKey : null,
    };
  }

  async function fetchObservations(currency: string, from: string, to: string, apiKey: string | null): Promise<FetchResult> {
    const path = `/Observations/SEK${currency}PMI/${from}/${to}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(RIKSBANK_BASE_URL + path, {
        method: "GET",
        headers: { Accept: "application/json", ...(apiKey ? { "Ocp-Apim-Subscription-Key": apiKey } : {}) },
        signal: controller.signal,
      });
      // The body read is inside the timeout too: a body that never arrives
      // is as much a transport failure as a connect that hangs.
      text = await res.text();
    } catch (err) {
      log({ currency, from, to, status: 0, detail: transportSummary(err) });
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
    // 204 = no observation in the interval (weekend/holiday only, or a
    // currency Riksbanken does not publish — verified 2026-10-24 for
    // SEKAEDPMI). 400/404 are read the same way: no rate from Riksbanken.
    if (res.status === 204 || res.status === 400 || res.status === 404) {
      if (res.status !== 204) log({ currency, from, to, status: res.status, detail: "no series" });
      return { ok: true, observations: [] };
    }
    if (res.status === 429) {
      log({ currency, from, to, status: 429, detail: "rate limited" });
      return { ok: false, reason: "rate_limited" };
    }
    if (res.status === 401 || res.status === 403) {
      log({ currency, from, to, status: res.status, detail: "unauthorized" });
      return { ok: false, reason: "unauthorized" };
    }
    if (!res.ok) {
      log({ currency, from, to, status: res.status, detail: "error" });
      return { ok: false, reason: "unavailable" };
    }
    const observations = parseObservations(text);
    if (observations === null) {
      log({ currency, from, to, status: res.status, detail: "unexpected body" });
      return { ok: false, reason: "unexpected" };
    }
    return { ok: true, observations: observations.filter((o) => o.date >= from && o.date <= to) };
  }

  function lookup(currency: string, requestedDate: string, rate: StoredRate): ExchangeRateLookup {
    return { currency, requestedDate, date: rate.date, rate: rate.rate, source: rate.source };
  }

  const service = {
    readSettings,

    async viewSettings() {
      const { apiKey, source } = await readSettings();
      return { source, apiKeySet: apiKey !== null };
    },

    // "" keeps the stored key (the form never sees it), null removes it. The
    // audit trail records changed key NAMES only.
    async updateSettings(input: UpdateExchangeRateSettingsInput, userId: string | null) {
      const changed: string[] = [];
      if (input.source !== undefined) {
        await writeExchangeRateSetting(db, EXCHANGE_RATE_SETTING_KEYS.source, input.source);
        changed.push(EXCHANGE_RATE_SETTING_KEYS.source);
      }
      if (input.apiKey === null) {
        await writeExchangeRateSetting(db, EXCHANGE_RATE_SETTING_KEYS.apiKey, null);
        changed.push(EXCHANGE_RATE_SETTING_KEYS.apiKey);
      } else if (input.apiKey !== undefined && input.apiKey !== "") {
        await writeExchangeRateSetting(db, EXCHANGE_RATE_SETTING_KEYS.apiKey, input.apiKey);
        changed.push(EXCHANGE_RATE_SETTING_KEYS.apiKey);
      }
      if (changed.length > 0) {
        changed.sort();
        await audit.log({ entityType: "exchange_rate_settings", entityId: null, action: "updated", detail: { keys: changed }, userId });
      }
      return service.viewSettings();
    },

    // The rate for (currency, date). SEK is always 1 without a lookup. A day
    // after today asks for today's (the latest known) rate.
    //
    // Setting riksbank (default): a manual rate for exactly the day wins (an
    // explicit decision for that day); then Riksbanken's latest banking day
    // ≤ the day — from the table when it can prove it, else one interval
    // call; then, when Riksbanken has nothing or does not answer, the latest
    // manual rate in [day−10, day] (a currency Riksbanken does not publish).
    // Setting manual: only the latest manual rate in [day−10, day].
    // Nothing found ⇒ ExchangeRateUnavailableError.
    async getRate(currencyInput: string, date: string): Promise<ExchangeRateLookup> {
      const currency = currencyInput.trim().toUpperCase();
      if (currency === SEK) return { currency, requestedDate: date, date, rate: 1, source: null };
      if (!CURRENCY.test(currency) || !ISO_DATE.test(date)) throw new ExchangeRateUnavailableError(currency, date);

      const todayDate = today();
      const target = date > todayDate ? todayDate : date;
      const from = addDays(target, -LOOKBACK_DAYS);
      const settings = await readSettings();
      const stored = await ratesInRange(db, currency, from, target);
      const manual = stored.filter((rate) => rate.source === "manual");
      const latestManual = manual.at(-1) ?? null;

      if (settings.source === "manual") {
        if (latestManual) return lookup(currency, date, latestManual);
        throw new ExchangeRateUnavailableError(currency, date);
      }

      const exactManual = manual.find((rate) => rate.date === target);
      if (exactManual) return lookup(currency, date, exactManual);

      const latestRiksbank = stored.filter((rate) => rate.source === "riksbank").at(-1) ?? null;
      const recently = fetchedRecently(currency, target);
      if (latestRiksbank && (latestRiksbank.date === target || recently || onlyWeekendBetween(latestRiksbank.date, target))) {
        return lookup(currency, date, latestRiksbank);
      }

      if (!recently) {
        const result = await fetchObservations(currency, from, target, settings.apiKey);
        if (result.ok) {
          await upsertRiksbankRates(db, currency, result.observations);
          markFetched(currency, target);
          const latest = [...result.observations].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
          if (latest) return lookup(currency, date, { date: latest.date, rate: latest.value, source: "riksbank" });
        }
      }

      if (latestManual) return lookup(currency, date, latestManual);
      throw new ExchangeRateUnavailableError(currency, date);
    },

    async list(query: ListExchangeRatesQuery) {
      return listRates(db, query);
    },

    // A manual rate (Ny kurs). Replaces an earlier manual rate for the day.
    async createManualRate(input: CreateExchangeRateInput, userId: string | null) {
      const { id, created, previousRate } = await upsertManualRate(db, input, userId);
      await audit.log({
        entityType: "exchange_rate",
        entityId: `${input.currency} ${input.date}`,
        action: created ? "created" : "updated",
        detail: created ? { rate: input.rate } : { before: { rate: previousRate }, after: { rate: input.rate } },
        userId,
      });
      return (await findRateById(db, id))!;
    },

    // Hämta från Riksbanken for an interval: one call, every published day
    // stored. A day after today is not asked for (nothing is published yet).
    async fetchRange(input: FetchExchangeRatesInput) {
      const todayDate = today();
      const to = input.to > todayDate ? todayDate : input.to;
      if (input.from > to) return { currency: input.currency, from: input.from, to: input.to, fetched: 0, rates: [] as StoredRate[] };
      const settings = await readSettings();
      const result = await fetchObservations(input.currency, input.from, to, settings.apiKey);
      if (!result.ok) throw new RiksbankUnavailableError(result.reason);
      await upsertRiksbankRates(db, input.currency, result.observations);
      const rates = await ratesInRange(db, input.currency, input.from, to);
      return {
        currency: input.currency,
        from: input.from,
        to: input.to,
        fetched: result.observations.length,
        rates: rates.filter((rate) => rate.source === "riksbank"),
      };
    },
  };

  return service;
}

export type ExchangeRateService = ReturnType<typeof createExchangeRateService>;
